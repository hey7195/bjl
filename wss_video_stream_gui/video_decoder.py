"""Realtime H264 decoder backed by ffmpeg."""

from __future__ import annotations

import subprocess
import threading
from queue import Queue
from typing import Optional


def frame_byte_size(width: int, height: int) -> int:
    return width * height * 3


def build_ffmpeg_command(ffmpeg_path: str, width: int, height: int) -> list[str]:
    return [
        ffmpeg_path,
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-f",
        "h264",
        "-i",
        "pipe:0",
        "-vf",
        f"scale={width}:{height}",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
    ]


class H264PreviewDecoder:
    def __init__(self, width: int, height: int, events: Queue, ffmpeg_path: str) -> None:
        self.width = width
        self.height = height
        self.events = events
        self.ffmpeg_path = ffmpeg_path
        self.process: Optional[subprocess.Popen] = None
        self._reader: Optional[threading.Thread] = None
        self._stderr_reader: Optional[threading.Thread] = None
        self._stopped = threading.Event()

    def start(self) -> None:
        if self.process is not None:
            return
        self.process = subprocess.Popen(
            build_ffmpeg_command(self.ffmpeg_path, self.width, self.height),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=False,
            text=False,
            creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
        )
        self._reader = threading.Thread(target=self._read_frames, daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_reader.start()
        self.events.put({"type": "preview_status", "payload": "decoder started"})

    def write(self, data: bytes) -> None:
        if self.process is None or self.process.stdin is None or self.process.poll() is not None:
            return
        try:
            stdin = self.process.stdin
            if hasattr(stdin, "buffer"):
                stdin = stdin.buffer
            stdin.write(data)
            stdin.flush()
        except Exception as exc:
            self.events.put({"type": "preview_error", "payload": str(exc)})

    def stop(self) -> None:
        self._stopped.set()
        process = self.process
        if process is None:
            return
        try:
            if process.stdin:
                process.stdin.close()
        except Exception:
            pass
        try:
            process.terminate()
            process.wait(timeout=1)
        except Exception:
            try:
                process.kill()
            except Exception:
                pass
        try:
            if process.stdout:
                process.stdout.close()
            if process.stderr:
                process.stderr.close()
        except Exception:
            pass
        self.process = None

    def _read_frames(self) -> None:
        if self.process is None or self.process.stdout is None:
            return
        size = frame_byte_size(self.width, self.height)
        stdout = self.process.stdout.buffer if hasattr(self.process.stdout, "buffer") else self.process.stdout
        while not self._stopped.is_set():
            data = stdout.read(size)
            if isinstance(data, str):
                data = data.encode("latin1", errors="ignore")
            if not data or len(data) < size:
                break
            self.events.put(
                {
                    "type": "preview_frame",
                    "payload": {
                        "width": self.width,
                        "height": self.height,
                        "rgb": data,
                    },
                }
            )

    def _read_stderr(self) -> None:
        if self.process is None or self.process.stderr is None:
            return
        for raw in self.process.stderr:
            if self._stopped.is_set():
                break
            if isinstance(raw, bytes):
                text = raw.decode("utf-8", errors="replace").strip()
            else:
                text = str(raw).strip()
            if text:
                self.events.put({"type": "preview_error", "payload": text})
