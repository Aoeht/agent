import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("bili_hub", Path(__file__).parents[1] / "server/bili_hub_api.py")
hub = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hub)


class TranscriptInputsTest(unittest.TestCase):
    def test_missing_srt_json_and_identity(self):
        bvid = "BV1AbCdEfGh2"
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"BILI_TRANSCRIPT_DIR": directory}):
            self.assertEqual(hub.build_transcript(bvid), {"source": "none"})
            Path(directory, bvid + ".srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nhello", encoding="utf-8")
            self.assertEqual(hub.build_transcript(bvid)["source"], "srt")
            data = {"bvid": bvid, "page": 1, "source": "asr", "segments": [{"start_s": 1, "end_s": 2, "text": "hello"}]}
            file = Path(directory, bvid + ".json")
            file.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual(hub.build_transcript(bvid)["segments"], data["segments"])
            data["page"] = 2
            file.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ValueError):
                hub.build_transcript(bvid)
            with self.assertRaises(ValueError):
                hub.build_transcript("../other")


if __name__ == "__main__":
    unittest.main()
