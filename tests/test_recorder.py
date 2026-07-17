import json
import tempfile
import unittest
from pathlib import Path

from wss_video_stream_gui.recorder import AnomalyStreamRecorder, build_recording_name, has_keyframe


class FakeMp4Writer:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.closed = False
        self.path.write_bytes(b"")

    def write(self, payload: bytes) -> None:
        with self.path.open("ab") as file:
            file.write(payload)

    def close(self) -> None:
        self.closed = True


def fake_writer_factory(path: Path) -> FakeMp4Writer:
    return FakeMp4Writer(path)


class StreamRecorderTests(unittest.TestCase):
    def test_build_recording_name_uses_timestamp_and_safe_url_hint(self) -> None:
        self.assertEqual(
            build_recording_name("2026-07-13 19:51:02.914", "wss://wt1.shipin1hao.com:8091/9004"),
            "20260713_195102_914_wt1_shipin1hao_com_8091_9004",
        )

    def test_has_keyframe_detects_sps_pps_idr(self) -> None:
        self.assertFalse(has_keyframe({"h264_nals": [{"nal_type": 1}]}))
        self.assertTrue(has_keyframe({"h264_nals": [{"nal_type": 7}]}))
        self.assertTrue(has_keyframe({"h264_nals": [{"nal_type": 8}]}))
        self.assertTrue(has_keyframe({"h264_nals": [{"nal_type": 5}]}))

    def test_anomaly_recorder_buffers_normal_frames_without_writing_h264(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = AnomalyStreamRecorder(Path(tmp), "wss://example.com/a", writer_factory=fake_writer_factory)

            events = recorder.observe(b"\x00\x00\x00\x01\x67abc", {
                "index": 1,
                "received_at": "2026-07-13 19:51:02.914",
                "size": 8,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 7, "payload_len": 4}],
            })

            self.assertEqual(events, [])
            self.assertEqual(recorder.buffered_frames, 1)
            self.assertEqual(list(Path(tmp).glob("*.mp4")), [])
            self.assertEqual(list(Path(tmp).glob("*.h264")), [])
            self.assertEqual(list(Path(tmp).glob("*.jsonl")), [])

    def test_anomaly_recorder_saves_buffer_when_sps_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = 0.0
            recorder = AnomalyStreamRecorder(
                Path(tmp),
                "wss://example.com/a",
                post_seconds=60.0,
                clock=lambda: now,
                writer_factory=fake_writer_factory,
            )
            first_summary = {
                "index": 1,
                "received_at": "2026-07-13 19:51:02.914",
                "size": 8,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 7, "payload_len": 4}],
            }
            changed_summary = {
                "index": 2,
                "received_at": "2026-07-13 19:51:03.014",
                "size": 8,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 7, "payload_len": 4}],
            }

            recorder.observe(b"\x00\x00\x00\x01\x67abc", first_summary)
            events = recorder.observe(b"\x00\x00\x00\x01\x67xyz", changed_summary)

            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["reason"], "SPS_CHANGED")
            video_path = Path(events[0]["path"])
            meta_path = Path(events[0]["meta"])
            self.assertEqual(video_path.suffix, ".mp4")
            self.assertEqual(list(Path(tmp).glob("*.h264")), [])
            self.assertEqual(video_path.read_bytes(), b"\x00\x00\x00\x01\x67abc\x00\x00\x00\x01\x67xyz")
            records = [json.loads(line) for line in meta_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(records[0]["event"], "anomaly")
            self.assertEqual(records[0]["reason"], "SPS_CHANGED")
            self.assertEqual(records[1]["event"], "binary")
            self.assertEqual(records[2]["event"], "binary")
            self.assertFalse(any(record["event"] == "stop" for record in records))

            now = 61.0
            recorder.observe(b"\x00\x00\x00\x01\x65idr", {
                "index": 3,
                "received_at": "2026-07-13 19:52:04.014",
                "size": 8,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 5, "payload_len": 4}],
            })
            records = [json.loads(line) for line in meta_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(records[-1]["event"], "stop")

    def test_anomaly_recorder_saves_buffer_on_unexpected_disconnect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = AnomalyStreamRecorder(Path(tmp), "wss://example.com/a", writer_factory=fake_writer_factory)
            recorder.observe(b"\x00\x00\x00\x01\x65idr", {
                "index": 1,
                "received_at": "2026-07-13 19:51:02.914",
                "size": 8,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 5, "payload_len": 4}],
            })

            event = recorder.save_event("WEBSOCKET_CLOSE", "server closed")

            self.assertIsNotNone(event)
            self.assertEqual(event["reason"], "WEBSOCKET_CLOSE")
            self.assertTrue(str(event["path"]).endswith(".mp4"))
            self.assertEqual(list(Path(tmp).glob("*.h264")), [])
            self.assertEqual(Path(event["path"]).read_bytes(), b"\x00\x00\x00\x01\x65idr")
            recorder.close()

    def test_anomaly_metadata_keeps_sei_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            recorder = AnomalyStreamRecorder(Path(tmp), "wss://example.com/a", writer_factory=fake_writer_factory)
            recorder.observe(b"\x00\x00\x00\x01\x06sei", {
                "index": 1,
                "received_at": "2026-07-15 10:26:35.610",
                "size": 7,
                "format": "h264_annexb",
                "h264_nals": [
                    {
                        "offset": 0,
                        "start_code_len": 4,
                        "nal_type": 6,
                        "payload_len": 3,
                        "sei": {
                            "CamTim": "2026-07-15 Wed 10:26:33",
                            "FrmRate": "12",
                            "TimStamp": "3202549719",
                            "CamPos": "111075afc570b3eM",
                            "AlmEvent": "000000",
                        },
                    }
                ],
            })

            event = recorder.save_event("WEBSOCKET_ERROR", "Connection timed out")
            records = [json.loads(line) for line in Path(event["meta"]).read_text(encoding="utf-8").splitlines()]

            self.assertEqual(records[1]["h264_nals"][0]["sei"]["CamTim"], "2026-07-15 Wed 10:26:33")
            self.assertEqual(records[1]["h264_nals"][0]["sei"]["CamPos"], "111075afc570b3eM")
            recorder.close()

    def test_anomaly_recorder_appends_post_disconnect_frames_to_same_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = 100.0
            recorder = AnomalyStreamRecorder(
                Path(tmp),
                "wss://example.com/a",
                post_seconds=60.0,
                clock=lambda: now,
                writer_factory=fake_writer_factory,
            )
            recorder.observe(b"before", {
                "index": 1,
                "received_at": "2026-07-13 19:51:02.914",
                "size": 6,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 5, "payload_len": 2}],
            })

            event = recorder.save_event("WEBSOCKET_ERROR", "Connection timed out")
            video_path = Path(event["path"])
            meta_path = Path(event["meta"])

            now = 120.0
            recorder.observe(b"after-reconnect", {
                "index": 2,
                "received_at": "2026-07-13 19:51:22.914",
                "size": 15,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 1, "payload_len": 11}],
            })

            self.assertEqual(video_path.read_bytes(), b"beforeafter-reconnect")
            self.assertEqual(video_path.suffix, ".mp4")
            self.assertEqual(list(Path(tmp).glob("*.h264")), [])
            records = [json.loads(line) for line in meta_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual([record["event"] for record in records[:3]], ["anomaly", "binary", "binary"])
            recorder.close()

    def test_anomaly_recorder_keeps_only_pre_window_before_anomaly(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = 0.0
            recorder = AnomalyStreamRecorder(
                Path(tmp),
                "wss://example.com/a",
                pre_seconds=60.0,
                post_seconds=0.0,
                clock=lambda: now,
                writer_factory=fake_writer_factory,
            )
            recorder.observe(b"too-old", {
                "index": 1,
                "received_at": "2026-07-13 19:50:00.000",
                "size": 7,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 5, "payload_len": 3}],
            })
            now = 61.0
            recorder.observe(b"recent", {
                "index": 2,
                "received_at": "2026-07-13 19:51:01.000",
                "size": 6,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 1, "payload_len": 2}],
            })

            event = recorder.save_event("WEBSOCKET_ERROR", "Connection timed out")

            self.assertEqual(Path(event["path"]).read_bytes(), b"recent")
            recorder.close()

    def test_save_event_trims_pre_window_at_event_time(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = 0.0
            recorder = AnomalyStreamRecorder(
                Path(tmp),
                "wss://example.com/a",
                pre_seconds=60.0,
                clock=lambda: now,
                writer_factory=fake_writer_factory,
            )
            recorder.observe(b"old-frame", {
                "index": 1,
                "received_at": "2026-07-13 19:50:00.000",
                "size": 9,
                "format": "h264_annexb",
                "h264_nals": [{"offset": 0, "start_code_len": 4, "nal_type": 5, "payload_len": 5}],
            })

            now = 61.0
            event = recorder.save_event("WEBSOCKET_ERROR", "Connection timed out")

            self.assertIsNone(event)


if __name__ == "__main__":
    unittest.main()
