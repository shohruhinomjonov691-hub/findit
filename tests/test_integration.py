"""End-to-end check with the real YOLOv8s weights and a local test image.

Skipped when the weights or the (git-ignored) test images are missing. Runs real
inference on CPU; nothing is downloaded.
"""

import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from findit.app import Settings, create_app

ROOT = Path(__file__).resolve().parent.parent
WEIGHTS = ROOT / "models" / "yolov8s.pt"
UPRIGHT = ROOT / "data" / "testset" / "09_iphone_desk.jpg"
ROTATED = ROOT / "data" / "derived" / "09_iphone_desk_exif6.jpg"


@unittest.skipUnless(WEIGHTS.is_file() and UPRIGHT.is_file() and ROTATED.is_file(), "weights or test images missing")
class RealModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(create_app(Settings(model_path=WEIGHTS)))
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client.__exit__(None, None, None)

    def detect(self, path):
        with open(path, "rb") as f:
            r = self.client.post("/api/detect", content=f.read(), headers={"Content-Type": "image/jpeg"})
        self.assertEqual(r.status_code, 200, r.text[:300])
        return r.json()

    def test_exif_rotated_upload_matches_upright(self):
        a, b = self.detect(UPRIGHT), self.detect(ROTATED)
        self.assertEqual((b["image"]["width"], b["image"]["height"]), (a["image"]["width"], a["image"]["height"]))
        self.assertEqual(b["image"]["exif_orientation"], 6)
        self.assertEqual([d["class_name"] for d in a["detections"]], [d["class_name"] for d in b["detections"]])
        for da, db in zip(a["detections"], b["detections"]):
            self.assertLess(max(abs(x - y) for x, y in zip(da["bbox_xyxy"], db["bbox_xyxy"])), 2.0)
        names = {d["class_name"] for d in a["detections"]}
        self.assertTrue({"cell phone", "laptop"} <= names, names)
        self.assertGreater(a["timing"]["inference_ms"], 0)


if __name__ == "__main__":
    unittest.main()
