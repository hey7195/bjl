import queue
import unittest
from unittest import mock

from wss_video_stream_gui.ws_client import StreamWorker


class StreamWorkerTests(unittest.TestCase):
    def test_format_anomaly_uses_chinese_log_labels(self) -> None:
        worker = StreamWorker(
            url="wss://example.com/a",
            headers_text="",
            timeout_s=8,
            head_len=64,
            full_hex=False,
            insecure=True,
            events=queue.Queue(),
            ffmpeg_path="ffmpeg",
            record_enabled=True,
            record_dir="recordings",
        )

        text = worker._format_anomaly(
            {
                "reason": "SPS_CHANGED",
                "detail": "old=aaa new=bbb",
                "path": r"E:\tmp\a.mp4",
                "meta": r"E:\tmp\a.jsonl",
                "frames": 12,
                "keyframes": 2,
                "bytes": 3456,
            }
        )

        self.assertIn("[异常视频流] SPS参数变化 old=aaa new=bbb", text)
        self.assertIn("已保存MP4视频=E:\\tmp\\a.mp4", text)
        self.assertIn("帧数=12 关键帧=2 字节=3456", text)
        self.assertIn("断线会自动重连", text)
        self.assertNotIn("[ANOMALY]", text)
        self.assertNotIn("saved=", text)

    def test_worker_reconnects_after_read_error_until_stopped(self) -> None:
        events: queue.Queue = queue.Queue()
        worker = StreamWorker(
            url="wss://example.com/a",
            headers_text="",
            timeout_s=8,
            head_len=64,
            full_hex=False,
            insecure=True,
            events=events,
            ffmpeg_path="ffmpeg",
            record_enabled=False,
            record_dir="recordings",
        )
        sockets = [mock.Mock(), mock.Mock()]
        sockets[0].recv_data_frame.side_effect = TimeoutError("Connection timed out")
        sockets[1].recv_data_frame.side_effect = lambda control_frame=True: worker.stop()

        with mock.patch("wss_video_stream_gui.ws_client.websocket.create_connection", side_effect=sockets) as create_connection:
            worker.start()
            worker.join(3)
            worker.stop()
            worker.join(1)

        records = [events.get_nowait() for _ in range(events.qsize())]
        statuses = [record["payload"] for record in records if record["type"] == "status"]
        self.assertGreaterEqual(create_connection.call_count, 2)
        self.assertGreaterEqual(statuses.count("connected"), 2)
        self.assertIn("reconnecting in 1s", statuses)


if __name__ == "__main__":
    unittest.main()
