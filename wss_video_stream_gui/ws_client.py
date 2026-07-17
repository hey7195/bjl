"""Background WebSocket reader for the GUI."""

from __future__ import annotations

import json
import ssl
import threading
import time
import urllib.parse
from pathlib import Path
from queue import Queue
from typing import Any, Dict, Optional

import websocket
from websocket import ABNF

from .recorder import AnomalyStreamRecorder, has_keyframe
from .stream_parser import current_timestamp, render_binary_report, summarize_binary_frame
from .video_decoder import H264PreviewDecoder


DEFAULT_URL = "wss://wt1.shipin1hao.com:8091/9004"

ANOMALY_REASON_LABELS = {
    "SPS_CHANGED": "SPS参数变化",
    "PPS_CHANGED": "PPS参数变化",
    "STREAM_GAP": "视频帧间隔异常",
    "WEBSOCKET_CLOSE": "连接被服务端关闭",
    "WEBSOCKET_ERROR": "连接读取异常",
}


def parse_header_lines(text: str) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if ":" not in line:
            raise ValueError(f"Invalid header: {line}")
        name, value = line.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def format_text_message(message: str) -> str:
    try:
        parsed = json.loads(message)
    except Exception:
        return message
    return json.dumps(parsed, ensure_ascii=False, indent=2)


class StreamWorker:
    def __init__(
        self,
        url: str,
        headers_text: str,
        timeout_s: float,
        head_len: int,
        full_hex: bool,
        insecure: bool,
        events: Queue,
        ffmpeg_path: str,
        record_enabled: bool,
        record_dir: str,
    ) -> None:
        self.url = url
        self.headers_text = headers_text
        self.timeout_s = timeout_s
        self.head_len = head_len
        self.full_hex = full_hex
        self.insecure = insecure
        self.events = events
        self.ffmpeg_path = ffmpeg_path
        self.record_enabled = record_enabled
        self.record_dir = record_dir
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._ws = None
        self._decoder: Optional[H264PreviewDecoder] = None
        self._seen_sps = False
        self._seen_pps = False
        self._seen_idr = False
        self._recorder: Optional[AnomalyStreamRecorder] = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        threading.Thread(target=self._close_resources, daemon=True).start()

    def join(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def _close_resources(self) -> None:
        if self._ws is not None:
            try:
                self._ws.settimeout(0.1)
                self._ws.close()
            except Exception:
                pass
        if self._decoder is not None:
            self._decoder.stop()

    def _emit(self, event_type: str, payload: Any) -> None:
        self.events.put({"type": event_type, "payload": payload})

    def _run(self) -> None:
        binary_count = 0
        text_count = 0
        total_binary_bytes = 0
        last_binary_at: Optional[float] = None
        started_at = time.monotonic()
        reconnect_delay_s = 1.0

        try:
            headers = parse_header_lines(self.headers_text)
            host = urllib.parse.urlparse(self.url).hostname or ""
            if self.record_enabled:
                self._recorder = AnomalyStreamRecorder(Path(self.record_dir), self.url, ffmpeg_path=self.ffmpeg_path)

            while not self._stop_event.is_set():
                try:
                    self._connect_once(headers, host)
                    while not self._stop_event.is_set():
                        opcode, frame = self._ws.recv_data_frame(control_frame=True)
                        data = frame.data or b""
                        if opcode == ABNF.OPCODE_TEXT:
                            text_count += 1
                            text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)
                            self._emit("log", f"[text #{text_count}] chars={len(text)}\n{format_text_message(text)}")
                            self._maybe_start_decoder(text)
                        elif opcode == ABNF.OPCODE_BINARY:
                            now = time.monotonic()
                            delta_ms = None if last_binary_at is None else round((now - last_binary_at) * 1000, 3)
                            last_binary_at = now
                            binary_count += 1
                            payload = bytes(data)
                            total_binary_bytes += len(payload)
                            head_len = len(payload) if self.full_hex else self.head_len
                            summary = summarize_binary_frame(
                                index=binary_count,
                                data=payload,
                                received_at=current_timestamp(),
                                delta_ms=delta_ms,
                                head_len=head_len,
                            )
                            self._update_keyframe_state(summary)
                            if self._recorder is not None:
                                for anomaly in self._recorder.observe(payload, summary):
                                    self._emit("log", self._format_anomaly(anomaly))
                                self._emit("recording", self._recorder.status())
                            keyframe = has_keyframe(summary)
                            if keyframe:
                                self._emit("log", "[KEYFRAME]\n" + render_binary_report(summary))
                            elif binary_count <= 3 or binary_count % 30 == 0 or self.full_hex:
                                self._emit("log", render_binary_report(summary))
                            if self._decoder is not None:
                                self._decoder.write(payload)
                            self._emit(
                                "stats",
                                {
                                    "text": text_count,
                                    "binary": binary_count,
                                    "bytes": total_binary_bytes,
                                    "rate": total_binary_bytes / max(time.monotonic() - started_at, 0.001),
                                    "format": summary["format"],
                                    "keyframe": self._keyframe_text(),
                                },
                            )
                        elif opcode == ABNF.OPCODE_CLOSE:
                            self._emit("log", f"[close] server closed: {data!r}")
                            self._save_recorder_event("WEBSOCKET_CLOSE", f"server closed: {data!r}")
                            break
                        elif opcode == ABNF.OPCODE_PING:
                            self._emit("log", "[control] ping")
                        elif opcode == ABNF.OPCODE_PONG:
                            self._emit("log", "[control] pong")
                        else:
                            self._emit("log", f"[control] opcode={opcode} size={len(data)}")
                except Exception as exc:
                    if self._stop_event.is_set():
                        break
                    self._emit("error", str(exc))
                    self._save_recorder_event("WEBSOCKET_ERROR", str(exc))
                finally:
                    if self._ws is not None:
                        try:
                            self._ws.close()
                        except Exception:
                            pass
                        self._ws = None

                if not self._stop_event.is_set():
                    self._emit("status", f"reconnecting in {reconnect_delay_s:.0f}s")
                    self._emit("log", f"[重连] {reconnect_delay_s:.0f}秒后重新连接，异常视频文件继续保留前后窗口。")
                    self._stop_event.wait(reconnect_delay_s)
        finally:
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    pass
            if self._decoder is not None:
                self._decoder.stop()
            if self._recorder is not None:
                self._recorder.close()
                self._emit("recording", self._recorder.status())
            self._emit("status", "disconnected")

    def _connect_once(self, headers: Dict[str, str], host: str) -> None:
        self._emit("status", "connecting")
        self._ws = websocket.create_connection(
            self.url,
            header=[f"{name}: {value}" for name, value in headers.items()],
            timeout=self.timeout_s,
            sslopt={"cert_reqs": ssl.CERT_NONE} if self.insecure else None,
            http_no_proxy=host,
        )
        self._ws.settimeout(self.timeout_s)
        self._emit("status", "connected")
        if getattr(self._ws, "headers", None):
            self._emit("log", "[handshake headers]\n" + "\n".join(f"{k}: {v}" for k, v in self._ws.headers.items()))

    def _maybe_start_decoder(self, text: str) -> None:
        if self._decoder is not None:
            return
        try:
            message = json.loads(text)
        except Exception:
            return
        payload = message.get("payload") if isinstance(message, dict) else None
        if not isinstance(payload, dict):
            return
        width = int(payload.get("width") or 0)
        height = int(payload.get("height") or 0)
        if width <= 0 or height <= 0:
            return
        preview_width = 640
        preview_height = max(int(height * preview_width / width), 1)
        try:
            self._decoder = H264PreviewDecoder(preview_width, preview_height, self.events, self.ffmpeg_path)
            self._decoder.start()
        except Exception as exc:
            self._emit("preview_error", f"Cannot start ffmpeg decoder: {exc}")

    def _update_keyframe_state(self, summary: Dict[str, Any]) -> None:
        changed = False
        for nal in summary.get("h264_nals", []):
            nal_type = nal.get("nal_type")
            if nal_type == 7 and not self._seen_sps:
                self._seen_sps = True
                changed = True
            elif nal_type == 8 and not self._seen_pps:
                self._seen_pps = True
                changed = True
            elif nal_type == 5 and not self._seen_idr:
                self._seen_idr = True
                changed = True
        if changed:
            self._emit("preview_status", self._keyframe_text())

    def _keyframe_text(self) -> str:
        if self._seen_sps and self._seen_pps and self._seen_idr:
            return "keyframe ready"
        missing = []
        if not self._seen_sps:
            missing.append("SPS")
        if not self._seen_pps:
            missing.append("PPS")
        if not self._seen_idr:
            missing.append("IDR")
        return "waiting for " + "/".join(missing)

    def _save_recorder_event(self, reason: str, detail: str) -> None:
        if self._recorder is None or self._stop_event.is_set():
            return
        anomaly = self._recorder.save_event(reason, detail)
        if anomaly is None:
            return
        self._emit("log", self._format_anomaly(anomaly))
        self._emit("recording", self._recorder.status())

    def _format_anomaly(self, anomaly: Dict[str, Any]) -> str:
        reason = str(anomaly["reason"])
        reason_label = ANOMALY_REASON_LABELS.get(reason, reason)
        return (
            f"[异常视频流] {reason_label} {anomaly.get('detail')}\n"
            f"已保存MP4视频={anomaly['path']}\n"
            f"元数据文件={anomaly['meta']}\n"
            f"帧数={anomaly['frames']} 关键帧={anomaly['keyframes']} 字节={anomaly['bytes']}\n"
            f"说明=已写入异常前约60秒，异常后约60秒会继续追加；断线会自动重连。"
        )
