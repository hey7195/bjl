"""Tkinter GUI for real-time WSS video stream inspection."""

from __future__ import annotations

import queue
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

import imageio_ffmpeg
from PIL import Image, ImageTk

from .ws_client import DEFAULT_URL, StreamWorker


class WssInspectorApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("WSS Video Stream Inspector")
        self.geometry("1280x820")
        self.minsize(1040, 680)

        self.events: queue.Queue = queue.Queue()
        self.worker: StreamWorker | None = None
        self.current_photo: ImageTk.PhotoImage | None = None
        self.ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()

        self.url_var = tk.StringVar(value=DEFAULT_URL)
        self.timeout_var = tk.StringVar(value="8")
        self.head_len_var = tk.StringVar(value="64")
        self.insecure_var = tk.BooleanVar(value=True)
        self.full_hex_var = tk.BooleanVar(value=False)
        self.record_var = tk.BooleanVar(value=True)
        self.record_dir_var = tk.StringVar(value=str(Path(__file__).resolve().parents[1] / "recordings"))
        self.status_var = tk.StringVar(value="disconnected")
        self.stats_var = tk.StringVar(value="text=0 binary=0 bytes=0 rate=0 B/s format=-")
        self.recording_var = tk.StringVar(value="异常监控：未启动")

        self._build_ui()
        self.after(80, self._poll_events)

    def _build_ui(self) -> None:
        self.columnconfigure(1, weight=1)
        self.rowconfigure(0, weight=1)

        left = ttk.Frame(self, padding=10)
        left.grid(row=0, column=0, sticky="ns")
        left.columnconfigure(0, weight=1)

        ttk.Label(left, text="WSS URL").grid(row=0, column=0, sticky="w")
        ttk.Entry(left, textvariable=self.url_var, width=42).grid(row=1, column=0, sticky="ew", pady=(2, 10))

        ttk.Label(left, text="Headers, one per line").grid(row=2, column=0, sticky="w")
        self.headers_text = ScrolledText(left, width=42, height=8, font=("Consolas", 10))
        self.headers_text.grid(row=3, column=0, sticky="ew", pady=(2, 10))

        opts = ttk.Frame(left)
        opts.grid(row=4, column=0, sticky="ew")
        opts.columnconfigure(1, weight=1)
        ttk.Label(opts, text="Timeout").grid(row=0, column=0, sticky="w")
        ttk.Entry(opts, textvariable=self.timeout_var, width=10).grid(row=0, column=1, sticky="w", padx=(8, 0))
        ttk.Label(opts, text="Head bytes").grid(row=1, column=0, sticky="w", pady=(8, 0))
        ttk.Entry(opts, textvariable=self.head_len_var, width=10).grid(row=1, column=1, sticky="w", padx=(8, 0), pady=(8, 0))

        ttk.Checkbutton(left, text="Skip TLS certificate verification", variable=self.insecure_var).grid(
            row=5, column=0, sticky="w", pady=(12, 0)
        )
        ttk.Checkbutton(left, text="Print full binary hex/ascii", variable=self.full_hex_var).grid(
            row=6, column=0, sticky="w", pady=(6, 0)
        )
        ttk.Checkbutton(left, text="Save abnormal stream as MP4", variable=self.record_var).grid(
            row=7, column=0, sticky="w", pady=(6, 0)
        )

        record_row = ttk.Frame(left)
        record_row.grid(row=8, column=0, sticky="ew", pady=(6, 0))
        record_row.columnconfigure(0, weight=1)
        ttk.Entry(record_row, textvariable=self.record_dir_var).grid(row=0, column=0, sticky="ew", padx=(0, 6))
        ttk.Button(record_row, text="Browse", command=self._browse_record_dir).grid(row=0, column=1)

        buttons = ttk.Frame(left)
        buttons.grid(row=9, column=0, sticky="ew", pady=(14, 0))
        buttons.columnconfigure(0, weight=1)
        buttons.columnconfigure(1, weight=1)
        self.connect_btn = ttk.Button(buttons, text="Connect", command=self._connect)
        self.connect_btn.grid(row=0, column=0, sticky="ew", padx=(0, 6))
        self.disconnect_btn = ttk.Button(buttons, text="Disconnect", command=self._disconnect, state="disabled")
        self.disconnect_btn.grid(row=0, column=1, sticky="ew")

        ttk.Label(left, textvariable=self.status_var).grid(row=10, column=0, sticky="w", pady=(18, 0))
        ttk.Label(left, textvariable=self.stats_var, wraplength=310).grid(row=11, column=0, sticky="w", pady=(8, 0))
        ttk.Label(left, textvariable=self.recording_var, wraplength=310).grid(row=12, column=0, sticky="w", pady=(8, 0))

        right = ttk.Frame(self, padding=(0, 10, 10, 10))
        right.grid(row=0, column=1, sticky="nsew")
        right.columnconfigure(0, weight=1)
        right.rowconfigure(1, weight=3)
        right.rowconfigure(2, weight=2)

        toolbar = ttk.Frame(right)
        toolbar.grid(row=0, column=0, sticky="ew", pady=(0, 8))
        ttk.Label(toolbar, text="Video preview").pack(side="left")
        ttk.Button(toolbar, text="Clear Log", command=self._clear_log).pack(side="right")

        self.video_label = ttk.Label(
            right,
            text="No video frame yet",
            anchor="center",
            background="#111111",
            foreground="#dddddd",
        )
        self.video_label.grid(row=1, column=0, sticky="nsew", pady=(0, 8))

        self.log_text = ScrolledText(right, font=("Consolas", 10), wrap="none")
        self.log_text.grid(row=2, column=0, sticky="nsew")

    def _connect(self) -> None:
        if self.worker is not None:
            return
        try:
            timeout_s = float(self.timeout_var.get().strip())
            head_len = int(self.head_len_var.get().strip())
        except ValueError:
            messagebox.showerror("Invalid input", "Timeout must be number, Head bytes must be integer.")
            return
        self._append_log(f"[connect] {self.url_var.get().strip()}")
        self.worker = StreamWorker(
            url=self.url_var.get().strip(),
            headers_text=self.headers_text.get("1.0", "end"),
            timeout_s=timeout_s,
            head_len=head_len,
            full_hex=self.full_hex_var.get(),
            insecure=self.insecure_var.get(),
            events=self.events,
            ffmpeg_path=self.ffmpeg_path,
            record_enabled=self.record_var.get(),
            record_dir=self.record_dir_var.get().strip(),
        )
        self.worker.start()
        self.connect_btn.configure(state="disabled")
        self.disconnect_btn.configure(state="normal")
        self.status_var.set("connecting")

    def _disconnect(self) -> None:
        if self.worker is not None:
            self.worker.stop()
        self.worker = None
        self.connect_btn.configure(state="normal")
        self.disconnect_btn.configure(state="disabled")
        self.status_var.set("disconnecting")

    def _clear_log(self) -> None:
        self.log_text.delete("1.0", "end")

    def _poll_events(self) -> None:
        handled = 0
        while handled < 100:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            handled += 1
            event_type = event.get("type")
            payload = event.get("payload")
            if event_type == "log":
                self._append_log(str(payload))
            elif event_type == "error":
                self._append_log(f"[error] {payload}")
                self.status_var.set("error")
            elif event_type == "status":
                self.status_var.set(str(payload))
                if payload == "disconnected":
                    self.worker = None
                    self.connect_btn.configure(state="normal")
                    self.disconnect_btn.configure(state="disabled")
            elif event_type == "stats":
                self.stats_var.set(
                    (
                        "text={text} binary={binary} bytes={bytes} "
                        "rate={rate:.1f} B/s format={format} {keyframe}"
                    ).format(**payload)
                )
            elif event_type == "preview_frame":
                self._show_frame(payload)
            elif event_type == "preview_status":
                self._append_log(f"[preview] {payload}")
            elif event_type == "preview_error":
                self._append_log(f"[preview error] {payload}")
            elif event_type == "recording":
                self.recording_var.set(
                    (
                        "异常监控：前{pre_seconds:.0f}秒+后{post_seconds:.0f}秒 缓冲帧={buffered_frames} "
                        "异常次数={anomalies} 已保存字节={bytes}\n"
                        "{path}\n{meta}"
                    ).format(**payload)
                )
        self.after(80, self._poll_events)

    def _append_log(self, text: str) -> None:
        self.log_text.insert("end", text.rstrip() + "\n\n")
        self.log_text.see("end")

    def _show_frame(self, payload) -> None:
        image = Image.frombytes("RGB", (payload["width"], payload["height"]), payload["rgb"])
        self.current_photo = ImageTk.PhotoImage(image)
        self.video_label.configure(image=self.current_photo, text="")

    def _browse_record_dir(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.record_dir_var.get())
        if selected:
            self.record_dir_var.set(selected)


def main() -> None:
    app = WssInspectorApp()
    app.mainloop()


if __name__ == "__main__":
    main()
