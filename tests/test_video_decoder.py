import unittest

from wss_video_stream_gui.video_decoder import build_ffmpeg_command, frame_byte_size


class VideoDecoderTests(unittest.TestCase):
    def test_frame_byte_size_uses_rgb24(self) -> None:
        self.assertEqual(frame_byte_size(640, 360), 640 * 360 * 3)

    def test_build_ffmpeg_command_decodes_h264_pipe_to_fixed_rgb_frames(self) -> None:
        cmd = build_ffmpeg_command("ffmpeg.exe", 640, 360)

        self.assertEqual(cmd[0], "ffmpeg.exe")
        self.assertIn("-f", cmd)
        self.assertIn("h264", cmd)
        self.assertIn("pipe:0", cmd)
        self.assertIn("scale=640:360", cmd)
        self.assertIn("rgb24", cmd)
        self.assertEqual(cmd[-1], "pipe:1")


if __name__ == "__main__":
    unittest.main()
