"""Recording abnormal stream payloads with per-frame metadata."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Deque, Dict, IO, List, Optional, Protocol, Tuple
from urllib.parse import urlparse


def build_recording_name(received_at: str, url: str) -> str:
    timestamp = re.sub(r"\D", "", received_at)
    timestamp = f"{timestamp[:8]}_{timestamp[8:14]}_{timestamp[14:17]}"
    parsed = urlparse(url)
    hint = f"{parsed.hostname or 'stream'}_{parsed.port or ''}_{parsed.path.strip('/')}"
    hint = re.sub(r"[^A-Za-z0-9]+", "_", hint).strip("_")
    return f"{timestamp}_{hint}"


def has_keyframe(summary: Dict[str, Any]) -> bool:
    return any(nal.get("nal_type") in (5, 7, 8) for nal in summary.get("h264_nals", []))


def nal_payload_hash(payload: bytes, nal: Dict[str, Any]) -> str:
    offset = int(nal["offset"]) + int(nal["start_code_len"])
    length = int(nal["payload_len"])
    return hashlib.sha256(payload[offset : offset + length]).hexdigest()[:16]


class VideoWriter(Protocol):
    def write(self, payload: bytes) -> None:
        ...

    def close(self) -> None:
        ...


class FfmpegMp4Writer:
    def __init__(self, path: Path, ffmpeg_path: str, fps: float = 25.0) -> None:
        self.path = path
        self.process = subprocess.Popen(
            [
                ffmpeg_path,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "h264",
                "-r",
                str(fps),
                "-i",
                "pipe:0",
                "-c:v",
                "copy",
                "-movflags",
                "+faststart",
                str(path),
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=False,
        )

    def write(self, payload: bytes) -> None:
        if self.process.stdin is None:
            raise RuntimeError("ffmpeg stdin is closed")
        stream = getattr(self.process.stdin, "buffer", self.process.stdin)
        stream.write(payload)
        stream.flush()

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


class AnomalyStreamRecorder:
    def __init__(
        self,
        directory: Path,
        url: str,
        max_frames: int = 3000,
        gap_threshold_ms: float = 3000.0,
        pre_seconds: float = 60.0,
        post_seconds: float = 60.0,
        clock: Callable[[], float] = time.monotonic,
        ffmpeg_path: str = "ffmpeg",
        writer_factory: Optional[Callable[[Path], VideoWriter]] = None,
    ) -> None:
        self.directory = directory
        self.url = url
        self.max_frames = max_frames
        self.gap_threshold_ms = gap_threshold_ms
        self.pre_seconds = pre_seconds
        self.post_seconds = post_seconds
        self._clock = clock
        self.ffmpeg_path = ffmpeg_path
        self._writer_factory = writer_factory or (lambda path: FfmpegMp4Writer(path, self.ffmpeg_path))
        self.bytes_written = 0
        self.anomalies = 0
        self.last_video_path: Optional[Path] = None
        self.last_meta_path: Optional[Path] = None
        self._buffer: Deque[Tuple[float, bytes, Dict[str, Any]]] = deque(maxlen=max_frames)
        self._sps_hash: Optional[str] = None
        self._pps_hash: Optional[str] = None
        self._active: Optional[Dict[str, Any]] = None

    @property
    def buffered_frames(self) -> int:
        return len(self._buffer)

    def observe(self, payload: bytes, summary: Dict[str, Any]) -> List[Dict[str, Any]]:
        now = self._clock()
        self._buffer.append((now, payload, dict(summary)))
        self._trim_buffer(now)
        self._append_active_frame(payload, summary)
        events: List[Dict[str, Any]] = []
        for reason, detail in self._detect_h264_changes(payload, summary):
            events.append(self._start_anomaly(reason, detail, summary))
        delta_ms = summary.get("delta_ms")
        if isinstance(delta_ms, (int, float)) and delta_ms > self.gap_threshold_ms:
            events.append(self._start_anomaly("STREAM_GAP", f"delta_ms={delta_ms}", summary))
        self._finish_active_if_due(now)
        return events

    def save_event(self, reason: str, detail: str, received_at: Optional[str] = None) -> Optional[Dict[str, Any]]:
        self._trim_buffer(self._clock())
        if not self._buffer:
            return None
        summary = self._buffer[-1][2]
        if received_at is not None:
            summary = dict(summary)
            summary["received_at"] = received_at
        return self._start_anomaly(reason, detail, summary)

    def status(self) -> Dict[str, Any]:
        return {
            "mode": "anomaly",
            "buffered_frames": self.buffered_frames,
            "anomalies": self.anomalies,
            "bytes": self.bytes_written,
            "path": str(self.last_video_path) if self.last_video_path else "-",
            "meta": str(self.last_meta_path) if self.last_meta_path else "-",
            "pre_seconds": self.pre_seconds,
            "post_seconds": self.post_seconds,
        }

    def _detect_h264_changes(self, payload: bytes, summary: Dict[str, Any]) -> List[Tuple[str, str]]:
        changes: List[Tuple[str, str]] = []
        for nal in summary.get("h264_nals", []):
            nal_type = nal.get("nal_type")
            if nal_type not in (7, 8):
                continue
            current_hash = nal_payload_hash(payload, nal)
            if nal_type == 7:
                if self._sps_hash is None:
                    self._sps_hash = current_hash
                elif self._sps_hash != current_hash:
                    changes.append(("SPS_CHANGED", f"old={self._sps_hash} new={current_hash}"))
                    self._sps_hash = current_hash
            elif nal_type == 8:
                if self._pps_hash is None:
                    self._pps_hash = current_hash
                elif self._pps_hash != current_hash:
                    changes.append(("PPS_CHANGED", f"old={self._pps_hash} new={current_hash}"))
                    self._pps_hash = current_hash
        return changes

    def _start_anomaly(self, reason: str, detail: str, summary: Dict[str, Any]) -> Dict[str, Any]:
        if self._active is not None:
            self._finish_active("superseded")
        self.directory.mkdir(parents=True, exist_ok=True)
        self.anomalies += 1
        name = build_recording_name(str(summary.get("received_at") or "unknown"), self.url)
        suffix = re.sub(r"[^A-Za-z0-9]+", "_", reason.lower()).strip("_")
        video_path = self.directory / f"{name}_anomaly_{self.anomalies:03d}_{suffix}.mp4"
        meta_path = self.directory / f"{name}_anomaly_{self.anomalies:03d}_{suffix}.jsonl"
        video_writer = self._writer_factory(video_path)
        meta_file = meta_path.open("w", encoding="utf-8")
        self._active = {
            "reason": reason,
            "detail": detail,
            "started_at": self._clock(),
            "video": video_writer,
            "meta": meta_file,
            "bytes": 0,
            "frames": 0,
            "keyframes": 0,
        }
        self._write_meta(
            meta_file,
            {
                "event": "anomaly",
                "reason": reason,
                "detail": detail,
                "url": self.url,
                "received_at": summary.get("received_at"),
                "index": summary.get("index"),
                "buffered_frames": len(self._buffer),
                "pre_seconds": self.pre_seconds,
                "post_seconds": self.post_seconds,
            },
        )
        for _, frame_payload, frame_summary in self._buffer:
            self._write_active_frame(frame_payload, frame_summary)
        bytes_written = int(self._active["bytes"])
        frames = int(self._active["frames"])
        keyframes = int(self._active["keyframes"])
        self._finish_active_if_due(self._clock())
        self.last_video_path = video_path
        self.last_meta_path = meta_path
        return {
            "reason": reason,
            "detail": detail,
            "path": str(video_path),
            "meta": str(meta_path),
            "bytes": bytes_written,
            "frames": frames,
            "keyframes": keyframes,
            "anomalies": self.anomalies,
            "post_seconds": self.post_seconds,
        }

    def _write_meta(self, meta_file, data: Dict[str, Any]) -> None:
        meta_file.write(json.dumps(data, ensure_ascii=False) + "\n")
        meta_file.flush()

    def _trim_buffer(self, now: float) -> None:
        while self._buffer and now - self._buffer[0][0] > self.pre_seconds:
            self._buffer.popleft()

    def _append_active_frame(self, payload: bytes, summary: Dict[str, Any]) -> None:
        if self._active is None:
            return
        self._write_active_frame(payload, summary)
        self._finish_active_if_due(self._clock())

    def _write_active_frame(self, payload: bytes, summary: Dict[str, Any]) -> None:
        if self._active is None:
            return
        video_writer: VideoWriter = self._active["video"]
        meta_file: IO[str] = self._active["meta"]
        video_writer.write(payload)
        keyframe = has_keyframe(summary)
        self._active["bytes"] += len(payload)
        self._active["frames"] += 1
        if keyframe:
            self._active["keyframes"] += 1
        self.bytes_written += len(payload)
        self._write_meta(
            meta_file,
            {
                "event": "binary",
                "received_at": summary.get("received_at"),
                "index": summary.get("index"),
                "size": len(payload),
                "format": summary.get("format"),
                "keyframe": keyframe,
                "h264_nals": summary.get("h264_nals", []),
            },
        )

    def _finish_active_if_due(self, now: float) -> None:
        if self._active is not None and now - float(self._active["started_at"]) >= self.post_seconds:
            self._finish_active("post_window_complete")

    def _finish_active(self, reason: str) -> None:
        if self._active is None:
            return
        meta_file: IO[str] = self._active["meta"]
        self._write_meta(
            meta_file,
            {
                "event": "stop",
                "reason": self._active["reason"],
                "finish_reason": reason,
                "bytes_written": self._active["bytes"],
                "binary_frames": self._active["frames"],
                "keyframes": self._active["keyframes"],
            },
        )
        self._active["video"].close()
        self._active["meta"].close()
        self._active = None

    def close(self) -> None:
        self._finish_active("recorder_closed")
