import unittest

from wss_video_stream_gui.stream_parser import (
    ascii_preview,
    detect_binary_format,
    parse_h264_sei_text,
    render_binary_report,
    summarize_binary_frame,
    word_preview,
)


class StreamParserTests(unittest.TestCase):
    def test_detects_h264_annexb(self) -> None:
        self.assertEqual(detect_binary_format(b"\x00\x00\x00\x01\x67abc"), "h264_annexb")

    def test_binary_summary_contains_realtime_fields_and_nal_details(self) -> None:
        summary = summarize_binary_frame(
            index=2,
            data=b"\x00\x00\x00\x01\x65\x88\x84",
            received_at="2026-07-13 20:10:00.123",
            delta_ms=33.3,
            head_len=16,
        )

        self.assertEqual(summary["index"], 2)
        self.assertEqual(summary["received_at"], "2026-07-13 20:10:00.123")
        self.assertEqual(summary["delta_ms"], 33.3)
        self.assertEqual(summary["size"], 7)
        self.assertEqual(summary["format"], "h264_annexb")
        self.assertEqual(summary["head_hex"], "00 00 00 01 65 88 84")
        self.assertEqual(summary["head_ascii"], "....e..")
        self.assertEqual(summary["h264_nals"][0]["offset"], 0)
        self.assertEqual(summary["h264_nals"][0]["start_code_len"], 4)
        self.assertEqual(summary["h264_nals"][0]["nal_header"], "0x65")
        self.assertEqual(summary["h264_nals"][0]["nal_type"], 5)
        self.assertEqual(summary["h264_nals"][0]["nal_type_name"], "IDR slice")

    def test_word_preview_decodes_candidate_header_fields(self) -> None:
        self.assertEqual(
            word_preview(b"\x01\x02\x03\x04", max_bytes=4),
            [
                {
                    "offset": 0,
                    "hex": "01 02 03 04",
                    "u32_be": 16909060,
                    "u32_le": 67305985,
                    "u16_be": 258,
                    "u16_le": 513,
                }
            ],
        )

    def test_ascii_preview_replaces_binary_bytes(self) -> None:
        self.assertEqual(ascii_preview(b"A\x00\xffZ"), "A..Z")

    def test_render_binary_report_is_gui_ready_text(self) -> None:
        report = render_binary_report(
            summarize_binary_frame(
                index=1,
                data=b"\x00\x00\x00\x01\x61hello",
                received_at="2026-07-13 20:10:00.000",
                delta_ms=None,
                head_len=32,
            )
        )

        self.assertIn("[binary #1]", report)
        self.assertIn("received_at=2026-07-13 20:10:00.000", report)
        self.assertIn("size=10", report)
        self.assertIn("format=h264_annexb", report)
        self.assertIn("nal offset=0 start=4 header=0x61 type=1(P/B slice) payload_len=6", report)
        self.assertIn("word offset=0 hex=00 00 00 01 u32_be=1", report)

    def test_parses_h264_sei_camera_metadata(self) -> None:
        sei_text = (
            "    38184cc8cea2"
            "CamTim: 2026-07-15 Wed 10:26:33\r\n"
            "FrmRate: 12\r\n"
            "TimStamp: 3202549719\r\n"
            "CamPos: 111075afc570b3eM\r\n"
            "AlmEvent: 000000"
        )
        payload = b"\x00\x00\x00\x01\x06\x05\x97" + sei_text.encode("ascii")

        summary = summarize_binary_frame(
            index=1,
            data=payload,
            received_at="2026-07-15 10:26:35.610",
            delta_ms=1.2,
            head_len=64,
        )

        self.assertEqual(parse_h264_sei_text(sei_text.encode("ascii"))["CamTim"], "2026-07-15 Wed 10:26:33")
        self.assertEqual(summary["h264_nals"][0]["nal_type"], 6)
        self.assertEqual(summary["h264_nals"][0]["sei"]["CamTim"], "2026-07-15 Wed 10:26:33")
        self.assertEqual(summary["h264_nals"][0]["sei"]["FrmRate"], "12")
        self.assertEqual(summary["h264_nals"][0]["sei"]["TimStamp"], "3202549719")
        self.assertEqual(summary["h264_nals"][0]["sei"]["CamPos"], "111075afc570b3eM")
        self.assertEqual(summary["h264_nals"][0]["sei"]["AlmEvent"], "000000")

        report = render_binary_report(summary)
        self.assertIn("sei CamTim=2026-07-15 Wed 10:26:33", report)
        self.assertIn("FrmRate=12", report)
        self.assertIn("TimStamp=3202549719", report)
        self.assertIn("CamPos=111075afc570b3eM", report)
        self.assertIn("AlmEvent=000000", report)


if __name__ == "__main__":
    unittest.main()
