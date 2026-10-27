"""EXIF orientation: detector input and drawn output share the upright pixel frame."""

import io
import unittest

from PIL import Image

from findit.detector import EXIF_ORIENTATION_TAG, Detection, draw, load_oriented


def jpeg_with_orientation(img: Image.Image, orientation: int) -> io.BytesIO:
    exif = Image.Exif()
    exif[EXIF_ORIENTATION_TAG] = orientation
    buf = io.BytesIO()
    img.save(buf, format="JPEG", exif=exif, quality=95)
    buf.seek(0)
    return buf


class OrientationTest(unittest.TestCase):
    def setUp(self):
        # 200x100 landscape, red block in the top-left corner of the stored pixels.
        self.stored = Image.new("RGB", (200, 100), "white")
        self.stored.paste((255, 0, 0), (0, 0, 40, 20))

    def test_orientation_6_rotates_to_portrait(self):
        img, meta = load_oriented(jpeg_with_orientation(self.stored, 6))
        self.assertEqual((meta["raw_width"], meta["raw_height"]), (200, 100))
        self.assertEqual(meta["exif_orientation"], 6)
        self.assertEqual((meta["width"], meta["height"]), (100, 200))
        self.assertEqual(img.size, (100, 200))
        # Orientation 6 = rotate 90° clockwise to display: stored top-left goes to top-right.
        r, g, b = img.getpixel((90, 10))
        self.assertGreater(r, 200)
        self.assertLess(g, 60)

    def test_no_orientation_tag_is_unchanged(self):
        buf = io.BytesIO()
        self.stored.save(buf, format="JPEG")
        buf.seek(0)
        img, meta = load_oriented(buf)
        self.assertEqual(meta["exif_orientation"], 1)
        self.assertEqual(img.size, (200, 100))

    def test_draw_keeps_size(self):
        img, _ = load_oriented(jpeg_with_orientation(self.stored, 6))
        out = draw(img, [Detection(0, "person", 0.9, [80.0, 0.0, 100.0, 40.0])])
        self.assertEqual(out.size, img.size)


if __name__ == "__main__":
    unittest.main()
