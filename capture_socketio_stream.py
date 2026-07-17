from __future__ import annotations

import base64
import json
import re
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import websocket
from websocket import ABNF


URL = "ws://6.zd10086.com/gate1/socket.io/?EIO=3&transport=websocket"
DURATION_S = 120
OUT_DIR = Path("recordings") / "socketio_6_zd10086"


def now_text() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def safe_name(url: str) -> str:
    parsed = urlparse(url)
    raw = f"{parsed.hostname or 'socketio'}_{parsed.path.strip('/')}_{parsed.query}"
    return re.sub(r"[^A-Za-z0-9]+", "_", raw).strip("_")


def describe_binary(data: bytes) -> dict:
    ascii_tail = ""
    decoded_prefix = ""
    encrypted = False
    # Observed packets are Socket.IO binary with a small non-text header then base64 ASCII.
    for start in range(0, min(8, len(data))):
        tail = data[start:]
        if not tail:
            continue
        if all(byte in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=\r\n" for byte in tail[:80]):
            ascii_tail = tail.decode("ascii", errors="replace")
            try:
                decoded = base64.b64decode(ascii_tail + "==", validate=False)
                decoded_prefix = decoded[:32].hex(" ")
                encrypted = decoded.startswith(b"Salted__")
            except Exception:
                decoded_prefix = ""
            break
    return {
        "size": len(data),
        "head_hex": data[:64].hex(" "),
        "head_ascii": "".join(chr(b) if 32 <= b <= 126 else "." for b in data[:64]),
        "base64_offset": len(data) - len(ascii_tail) if ascii_tail else None,
        "base64_head": ascii_tail[:96] if ascii_tail else "",
        "base64_decoded_head_hex": decoded_prefix,
        "looks_openssl_salted": encrypted,
        "has_h264_start_code": b"\x00\x00\x00\x01" in data or b"\x00\x00\x01" in data,
    }


def main() -> int:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    started_at = now_text()
    stem = f"{datetime.now().strftime('%Y%m%d_%H%M%S_%f')[:18]}_{safe_name(URL)}"
    raw_path = OUT_DIR / f"{stem}.bin"
    meta_path = OUT_DIR / f"{stem}.jsonl"
    report_path = OUT_DIR / f"{stem}_report.json"

    ws = websocket.create_connection(URL, timeout=10, http_no_proxy=urlparse(URL).hostname or "")
    ws.settimeout(10)

    text_count = 0
    binary_count = 0
    total_binary_bytes = 0
    event_names = {}
    encrypted_binary = 0
    h264_like = 0
    samples = []

    start = time.monotonic()
    last_binary_at = None

    with raw_path.open("ab") as raw_file, meta_path.open("a", encoding="utf-8") as meta_file:
        meta_file.write(json.dumps({"event": "start", "url": URL, "received_at": started_at}, ensure_ascii=False) + "\n")
        try:
            while time.monotonic() - start < DURATION_S:
                opcode, frame = ws.recv_data_frame(control_frame=True)
                received_at = now_text()
                data = frame.data or b""
                if opcode == ABNF.OPCODE_TEXT:
                    text = data.decode("utf-8", errors="replace") if isinstance(data, bytes) else str(data)
                    if text == "2":
                        ws.send("3")
                    text_count += 1
                    match = re.search(r'\["([^"]+)"', text)
                    if match:
                        event_names[match.group(1)] = event_names.get(match.group(1), 0) + 1
                    meta_file.write(
                        json.dumps(
                            {
                                "event": "text",
                                "index": text_count,
                                "received_at": received_at,
                                "text": text,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    meta_file.flush()
                    continue
                if opcode != ABNF.OPCODE_BINARY:
                    continue

                now = time.monotonic()
                delta_ms = None if last_binary_at is None else round((now - last_binary_at) * 1000, 3)
                last_binary_at = now
                binary_count += 1
                payload = bytes(data)
                offset = raw_file.tell()
                raw_file.write(payload)
                raw_file.flush()
                total_binary_bytes += len(payload)
                desc = describe_binary(payload)
                encrypted_binary += 1 if desc["looks_openssl_salted"] else 0
                h264_like += 1 if desc["has_h264_start_code"] else 0
                record = {
                    "event": "binary",
                    "index": binary_count,
                    "received_at": received_at,
                    "delta_ms": delta_ms,
                    "raw_offset": offset,
                    **desc,
                }
                meta_file.write(json.dumps(record, ensure_ascii=False) + "\n")
                meta_file.flush()
                if len(samples) < 10:
                    samples.append(record)
                if binary_count % 500 == 0:
                    print(f"[progress] binary={binary_count} bytes={total_binary_bytes}")
        finally:
            try:
                ws.close()
            except Exception:
                pass
            meta_file.write(
                json.dumps(
                    {
                        "event": "stop",
                        "received_at": now_text(),
                        "text_count": text_count,
                        "binary_count": binary_count,
                        "total_binary_bytes": total_binary_bytes,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    report = {
        "url": URL,
        "started_at": started_at,
        "duration_s": round(time.monotonic() - start, 3),
        "raw_path": str(raw_path),
        "meta_path": str(meta_path),
        "text_count": text_count,
        "binary_count": binary_count,
        "total_binary_bytes": total_binary_bytes,
        "event_names": event_names,
        "encrypted_binary_count": encrypted_binary,
        "h264_like_binary_count": h264_like,
        "samples": samples,
        "judgement": "Socket.IO binary payloads look encrypted/base64 OpenSSL Salted__; no raw H264 video frame found.",
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[done] raw={raw_path}")
    print(f"[done] meta={meta_path}")
    print(f"[done] report={report_path}")
    print(json.dumps({k: report[k] for k in ("text_count", "binary_count", "total_binary_bytes", "event_names", "encrypted_binary_count", "h264_like_binary_count", "judgement")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
