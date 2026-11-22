"""Very large uploads: decoded at reduced size (box coordinates mapped back), and peak memory
stays far below the full-size buffers. The 16 MP default leaves normal photos untouched."""

import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from findit.app import Settings
from findit.detector import EXIF_ORIENTATION_TAG, Detection
from tests.test_app import ClientMixin, image_bytes

ROOT = Path(__file__).resolve().parent.parent


class RelativeBoxStub:
    """Returns one box at fixed fractions of whatever image it is given."""

    def __init__(self, model_path):
        self.model_path = model_path
        self.class_names = {0: "person"}
        self.seen = []

    def detect(self, img):
        self.seen.append(img.size)
        w, h = img.size
        return [Detection(0, "person", 0.9, [0.1 * w, 0.2 * h, 0.5 * w, 0.6 * h])], {"wall_ms": 1.0}


class ReducedDecodeApiTest(ClientMixin, unittest.TestCase):
    def client_with(self, **settings):
        client = self.make_client(settings=Settings(**settings))
        self.stub = RelativeBoxStub(self.stub.model_path)
        client.app.state.detector = self.stub
        return client

    def check_mapped(self, body, width, height):
        self.assertEqual((body["image"]["width"], body["image"]["height"]), (width, height))
        x1, y1, x2, y2 = body["detections"][0]["bbox_xyxy"]
        for got, want in zip(
            (x1, y1, x2, y2), (0.1 * width, 0.2 * height, 0.5 * width, 0.6 * height), strict=True
        ):
            self.assertAlmostEqual(got, want, delta=2.0)

    def test_large_jpeg_is_analysed_reduced_but_reported_in_original_frame(self):
        client = self.client_with(analysis_pixels=100_000)
        r = self.post(client, image_bytes((800, 600)))  # 480 000 px > 100 000
        self.assertEqual(r.status_code, 200, r.text)
        w, h = self.stub.seen[0]
        self.assertLess(w * h, 480_000 // 2, "the model saw a reduced image")
        self.check_mapped(r.json(), 800, 600)

    def test_exif_rotated_large_jpeg_maps_back_to_upright_frame(self):
        client = self.client_with(analysis_pixels=100_000)
        r = self.post(client, image_bytes((800, 600), orientation=6))  # stored 800x600, upright 600x800
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.stub.seen[0][0] < self.stub.seen[0][1], True, "reduced image is upright too")
        self.check_mapped(r.json(), 600, 800)
        self.assertEqual(r.json()["image"]["exif_orientation"], 6)

    def test_large_png_is_reduced_too(self):
        client = self.client_with(analysis_pixels=100_000)
        r = self.post(client, image_bytes((800, 600), fmt="PNG"), ctype="image/png")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertLess(self.stub.seen[0][0] * self.stub.seen[0][1], 240_000)
        self.check_mapped(r.json(), 800, 600)

    def test_images_up_to_the_threshold_are_not_touched(self):
        client = self.client_with()  # default threshold 16 MP
        r = self.post(client, image_bytes((800, 600)))
        self.assertEqual(self.stub.seen, [(800, 600)])
        self.check_mapped(r.json(), 800, 600)

    def test_every_pixel_mode_and_format_keeps_orientation_and_mapping(self):
        """Reduced decoding must also work for palette, grey, alpha and CMYK images."""
        for fmt, mode in [("PNG", "RGB"), ("PNG", "RGBA"), ("PNG", "L"), ("PNG", "P"), ("JPEG", "L"), ("JPEG", "CMYK")]:
            with self.subTest(fmt=fmt, mode=mode):
                img = Image.new(mode, (800, 600), (0, 0, 0, 0) if mode == "CMYK" else "white")
                exif = Image.Exif()
                exif[EXIF_ORIENTATION_TAG] = 6
                buf = io.BytesIO()
                img.save(buf, format=fmt, exif=exif)
                client = self.client_with(analysis_pixels=100_000)
                r = self.post(client, buf.getvalue(), ctype=f"image/{fmt.lower()}")
                self.assertEqual(r.status_code, 200, r.text)
                w, h = self.stub.seen[-1]
                self.assertLess(w, h, "the reduced image is upright")
                self.check_mapped(r.json(), 600, 800)

    def test_documented_upload_limits_are_unchanged(self):
        s = Settings()
        self.assertEqual((s.max_pixels, s.max_side, s.max_upload_bytes), (40_000_000, 12_000, 10 * 1024 * 1024))


MEASURE = r"""
import io, json, resource, sys
sys.path.insert(0, sys.argv[2])
from findit.app import Settings, decode_image
data = open(sys.argv[1], "rb").read()
def peak(): return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / (2**20 if sys.platform == "darwin" else 2**10)
before = peak()
img, meta = decode_image(data, Settings())
print(json.dumps({"delta_mib": peak() - before, "size": img.size, "meta": [meta["width"], meta["height"]]}))
"""


class PeakMemoryTest(unittest.TestCase):
    """A 39 MP image needs ~118 MiB per full-size RGB copy. Decoding it at full size peaked
    ~+420 MiB in this step alone (measured on macOS); reduced decoding must stay far below."""

    def measure(self, fmt):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / f"big.{fmt.lower()}"
            Image.new("RGB", (7000, 5600), (90, 120, 150)).save(path, format=fmt)
            self.assertLess(path.stat().st_size, 10 * 1024 * 1024, "within the documented upload limit")
            out = subprocess.run([sys.executable, "-I", "-c", MEASURE, str(path), str(ROOT)],
                                 capture_output=True, text=True, check=True, timeout=120)
            return json.loads(out.stdout.strip().splitlines()[-1])

    def test_39mp_jpeg_decodes_small(self):
        r = self.measure("JPEG")
        self.assertEqual(r["meta"], [7000, 5600])
        self.assertLessEqual(r["size"][0] * r["size"][1], 16_000_000)
        self.assertLess(r["delta_mib"], 200, r)

    def test_39mp_png_never_holds_several_full_copies(self):
        r = self.measure("PNG")
        self.assertEqual(r["meta"], [7000, 5600])
        self.assertLessEqual(r["size"][0] * r["size"][1], 16_000_000)
        self.assertLess(r["delta_mib"], 270, r)  # PNG must be decoded in full once (~118 MiB + zlib working
        # space; measured 225, versus 300 without reduction): this only guards against more copies


if __name__ == "__main__":
    unittest.main()
