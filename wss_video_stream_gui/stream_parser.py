"""Frame parsing helpers for WSS video streams."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, Iterable, List, Optional


H264_NAL_TYPE_NAMES = {
    1: "P/B slice",
    5: "IDR slice",
    6: "SEI",
    7: "SPS",
    8: "PPS",
    9: "AUD",
}


def detect_binary_format(data: bytes) -> str:
    if data.startswith((b"\x00\x00\x00\x01", b"\x00\x00\x01")):
        return "h264_annexb"
    if data.startswith(b"FLV"):
        return "flv"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if len(data) >= 8 and data[4:8] in (b"ftyp", b"moof", b"mdat"):
        return "mp4_fragment"
    return "unknown"


def ascii_preview(data: bytes) -> str:
    return "".join(chr(byte) if 32 <= byte <= 126 else "." for byte in data)


def word_preview(data: bytes, max_bytes: int = 32) -> List[Dict[str, Any]]:
    words: List[Dict[str, Any]] = []
    for offset in range(0, len(data[:max_bytes]), 4):
        chunk = data[offset : offset + 4]
        padded = chunk.ljust(4, b"\x00")
        first2 = padded[:2]
        words.append(
            {
                "offset": offset,
                "hex": " ".join(f"{byte:02x}" for byte in chunk),
                "u32_be": int.from_bytes(padded, "big"),
                "u32_le": int.from_bytes(padded, "little"),
                "u16_be": int.from_bytes(first2, "big"),
                "u16_le": int.from_bytes(first2, "little"),
            }
        )
    return words


def parse_h264_sei_text(payload: bytes) -> Dict[str, str]:
    text = payload.decode("utf-8", errors="ignore")
    result: Dict[str, str] = {}
    for key in ("CamTim", "FrmRate", "TimStamp", "CamPos", "AlmEvent"):
        marker = f"{key}:"
        start = text.find(marker)
        if start < 0:
            continue
        value_start = start + len(marker)
        value_end = text.find("\n", value_start)
        if value_end < 0:
            value_end = len(text)
        value = text[value_start:value_end].strip().strip("\r")
        if value:
            result[key] = value
    return result


def current_timestamp() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def summarize_binary_frame(
    index: int,
    data: bytes,
    received_at: Optional[str],
    delta_ms: Optional[float],
    head_len: int,
) -> Dict[str, Any]:
    head = data[:head_len]
    summary: Dict[str, Any] = {
        "index": index,
        "received_at": received_at,
        "delta_ms": delta_ms,
        "size": len(data),
        "format": detect_binary_format(data),
        "head_hex": " ".join(f"{byte:02x}" for byte in head),
        "head_ascii": ascii_preview(head),
        "word_preview": word_preview(data, max_bytes=min(head_len, 32)),
    }
    nals = list(iter_h264_nals(data, limit=16))
    if nals:
        summary["h264_nals"] = nals
    return summary


def iter_h264_nals(data: bytes, limit: int = 16) -> Iterable[Dict[str, Any]]:
    starts = _find_h264_start_codes(data)
    for idx, (offset, start_len) in enumerate(starts[:limit]):
        nal_pos = offset + start_len
        if nal_pos >= len(data):
            continue
        next_offset = starts[idx + 1][0] if idx + 1 < len(starts) else len(data)
        nal_type = data[nal_pos] & 0x1F
        nal: Dict[str, Any] = {
            "offset": offset,
            "start_code_len": start_len,
            "nal_header": f"0x{data[nal_pos]:02x}",
            "nal_type": nal_type,
            "nal_type_name": H264_NAL_TYPE_NAMES.get(nal_type, "unknown"),
            "payload_len": max(next_offset - nal_pos, 0),
        }
        if nal_type == 6:
            sei = parse_h264_sei_text(data[nal_pos + 1 : next_offset])
            if sei:
                nal["sei"] = sei
        yield nal


def _find_h264_start_codes(data: bytes) -> List[tuple[int, int]]:
    starts: List[tuple[int, int]] = []
    pos = 0
    while pos < len(data) - 3:
        if data[pos : pos + 4] == b"\x00\x00\x00\x01":
            starts.append((pos, 4))
            pos += 4
            continue
        if data[pos : pos + 3] == b"\x00\x00\x01":
            starts.append((pos, 3))
            pos += 3
            continue
        pos += 1
    return starts


def render_binary_report(summary: Dict[str, Any]) -> str:
    lines = [
        f"[binary #{summary['index']}]",
        (
            f"received_at={summary.get('received_at')} "
            f"delta_ms={summary.get('delta_ms')} "
            f"size={summary['size']} format={summary['format']}"
        ),
        f"head_hex={summary['head_hex']}",
        f"head_ascii={summary['head_ascii']}",
    ]
    for nal in summary.get("h264_nals", []):
        lines.append(
            "nal "
            f"offset={nal['offset']} "
            f"start={nal['start_code_len']} "
            f"header={nal['nal_header']} "
            f"type={nal['nal_type']}({nal['nal_type_name']}) "
            f"payload_len={nal['payload_len']}"
        )
        if nal.get("sei"):
            lines.append("sei " + " ".join(f"{key}={value}" for key, value in nal["sei"].items()))
    for word in summary.get("word_preview", []):
        lines.append(
            "word "
            f"offset={word['offset']} "
            f"hex={word['hex']} "
            f"u32_be={word['u32_be']} "
            f"u32_le={word['u32_le']} "
            f"u16_be={word['u16_be']} "
            f"u16_le={word['u16_le']}"
        )
    return "\n".join(lines)
