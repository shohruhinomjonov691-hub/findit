"""Create an EXIF-orientation variant of a test image for the end-to-end orientation check.

Stores the pixels rotated 90° counter-clockwise and sets Orientation=6, so a viewer
that honors EXIF shows the original upright image. Detections on the variant should
match the original image's detections.

    python scripts/make_exif_variant.py data/testset/09_iphone_desk.jpg data/derived/09_iphone_desk_exif6.jpg
"""

import sys
from pathlib import Path

from PIL import Image

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.parent.mkdir(parents=True, exist_ok=True)
with Image.open(src) as img:
    stored = img.convert("RGB").transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6
    stored.save(dst, quality=95, exif=exif)
print(f"{dst}: stored {stored.size}, orientation 6")
