from __future__ import annotations

import hashlib
import json
import ssl
import time
import urllib.parse
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

import websocket
from websocket import ABNF

from wss_video_stream_gui.recorder import AnomalyStreamRecorder, has_keyframe
from wss_video_stream_gui.stream_parser import summarize_binary_frame


URL = "wss://wt1.shipin1hao.com:8091/9001"
DURATION_S = 120
OUT_DIR = Path("recordings") / "analysis_9001"


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def nal_payload_hash(payload: bytes, nal: dict) -> str:
    offset = int(nal["offset"]) + int(nal["start_code_len"])
    length = int(nal["payload_len"])
    return hashlib.sha256(payload[offset : offset + length]).hexdigest()[:16]


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    host = urllib.parse.urlparse(URL).hostname or ""
    ws = websocket.create_connection(
        URL,
        timeout=8,
        sslopt={"cert_reqs": ssl.CERT_NONE},
        http_no_proxy=host,
    )
    ws.settimeout(8)

    recorder = AnomalyStreamRecorder(OUT_DIR, URL)
    binary_count = 0
    text_count = 0
    total_bytes = 0
    byte_offset = 0
    nal_counts = Counter()
    keyframes = []
    sps_hashes = Counter()
    pps_hashes = Counter()
    word_sequences = defaultdict(list)
    size_by_nal = defaultdict(list)
    text_messages = []
    first_received_at = ""
    started = time.monotonic()
    last_binary_at = None

    try:
        while time.monotonic() - started < DURATION_S:
            opcode, frame = ws.recv_data_frame(control_frame=True)
            data = frame.data or b""
            if opcode == ABNF.OPCODE_TEXT:
                text_count += 1
                text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)
                text_messages.append({"index": text_count, "received_at": now_text(), "text": text})
                continue
            if opcode != ABNF.OPCODE_BINARY:
                continue

            received_at = now_text()
            if not first_received_at:
                first_received_at = received_at

            now = time.monotonic()
            delta_ms = None if last_binary_at is None else round((now - last_binary_at) * 1000, 3)
            last_binary_at = now

            payload = bytes(data)
            binary_count += 1
            total_bytes += len(payload)
            summary = summarize_binary_frame(binary_count, payload, received_at, delta_ms, 64)
            summary["byte_offset"] = byte_offset
            byte_offset += len(payload)
            for anomaly in recorder.observe(payload, summary):
                print(
                    f"[ANOMALY] {anomaly['reason']} {anomaly['detail']} "
                    f"saved={anomaly['path']} meta={anomaly['meta']}"
                )

            nals = summary.get("h264_nals", [])
            for nal in nals:
                nal_type = nal["nal_type"]
                nal_counts[nal_type] += 1
                size_by_nal[nal_type].append(len(payload))
                if nal_type == 7:
                    sps_hashes[nal_payload_hash(payload, nal)] += 1
                elif nal_type == 8:
                    pps_hashes[nal_payload_hash(payload, nal)] += 1
            for word in summary.get("word_preview", []):
                word_sequences[word["offset"]].append(word["u32_be"])
            if has_keyframe(summary):
                keyframes.append(
                    {
                        "index": binary_count,
                        "received_at": received_at,
                        "byte_offset": summary["byte_offset"],
                        "size": len(payload),
                        "nals": nals,
                    }
                )
                print(f"[KEYFRAME] index={binary_count} at={received_at} offset={summary['byte_offset']} nals={nals}")
            if binary_count % 500 == 0:
                elapsed = time.monotonic() - started
                print(f"[progress] {elapsed:.1f}s binary={binary_count} bytes={total_bytes}")
    finally:
        try:
            ws.close()
        except Exception:
            pass

    duration = max(time.monotonic() - started, 0.001)
    monotonic_offsets = {}
    for offset, values in word_sequences.items():
        if len(values) < 3:
            continue
        diffs = [b - a for a, b in zip(values, values[1:])]
        monotonic_offsets[offset] = {
            "samples": len(values),
            "first": values[0],
            "last": values[-1],
            "positive_ratio": sum(1 for d in diffs if d > 0) / len(diffs),
            "zero_ratio": sum(1 for d in diffs if d == 0) / len(diffs),
            "common_diffs": Counter(diffs).most_common(5),
        }

    report = {
        "url": URL,
        "duration_s": round(duration, 3),
        "text_count": text_count,
        "binary_count": binary_count,
        "total_bytes": total_bytes,
        "rate_Bps": round(total_bytes / duration, 1),
        "anomaly_count": recorder.anomalies,
        "last_anomaly_h264": str(recorder.last_video_path) if recorder.last_video_path else "",
        "last_anomaly_jsonl": str(recorder.last_meta_path) if recorder.last_meta_path else "",
        "text_messages": text_messages,
        "nal_counts": dict(nal_counts),
        "keyframe_count": len(keyframes),
        "keyframes": keyframes[:50],
        "sps_hashes": dict(sps_hashes),
        "pps_hashes": dict(pps_hashes),
        "monotonic_word_candidates": monotonic_offsets,
        "size_stats_by_nal": {
            str(k): {
                "count": len(v),
                "min": min(v),
                "max": max(v),
                "avg": round(sum(v) / len(v), 1),
            }
            for k, v in size_by_nal.items()
            if v
        },
    }
    report_path = OUT_DIR / f"analysis_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] report={report_path}")
    print(json.dumps({k: report[k] for k in ("binary_count", "total_bytes", "keyframe_count", "nal_counts", "sps_hashes", "pps_hashes")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
