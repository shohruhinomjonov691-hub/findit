"""YOLO detection wrapper: image -> bboxes in the EXIF-corrected pixel frame."""

from __future__ import annotations

import os
import time
from dataclasses import asdict, dataclass
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

EXIF_ORIENTATION_TAG = 0x0112


@dataclass
class Detection:
    class_id: int
    class_name: str
    score: float
    # Pixel coordinates in the oriented (upright) image: x1, y1, x2, y2.
    bbox_xyxy: list[float]


def load_oriented(path: Path) -> tuple[Image.Image, dict]:
    """Open an image, apply EXIF orientation and return it as RGB plus size metadata."""
    with Image.open(path) as raw:
        raw_size = raw.size
        orientation = raw.getexif().get(EXIF_ORIENTATION_TAG, 1)
        img = ImageOps.exif_transpose(raw).convert("RGB")
    meta = {
        "raw_width": raw_size[0],
        "raw_height": raw_size[1],
        "exif_orientation": orientation,
        "width": img.width,
        "height": img.height,
    }
    return img, meta


class Detector:
    """Loads the model once; call detect() for every image."""

    def __init__(self, model_path: Path, imgsz: int = 640, conf: float = 0.25, device: str = "cpu"):
        # Local weights only: no network checks, downloads or usage analytics (settings "sync").
        os.environ.setdefault("YOLO_OFFLINE", "1")
        t0 = time.perf_counter()
        from ultralytics import YOLO

        t1 = time.perf_counter()
        self.model = YOLO(str(model_path))
        self.import_seconds = t1 - t0
        self.load_seconds = time.perf_counter() - t1
        self.model_path = Path(model_path)
        self.imgsz = imgsz
        self.conf = conf
        self.device = device

    def detect(self, img: Image.Image) -> tuple[list[Detection], dict]:
        t0 = time.perf_counter()
        # A PIL image is passed so Ultralytics handles the RGB->BGR conversion itself.
        result = self.model.predict(img, imgsz=self.imgsz, conf=self.conf, device=self.device, verbose=False)[0]
        wall_ms = (time.perf_counter() - t0) * 1000
        assert tuple(result.orig_shape) == (img.height, img.width)

        detections = []
        boxes = result.boxes
        for xyxy, cls, score in zip(boxes.xyxy.tolist(), boxes.cls.tolist(), boxes.conf.tolist()):
            detections.append(
                Detection(
                    class_id=int(cls),
                    class_name=result.names[int(cls)],
                    score=round(float(score), 4),
                    bbox_xyxy=[round(v, 1) for v in xyxy],
                )
            )
        timing = {"wall_ms": round(wall_ms, 1), **{f"{k}_ms": round(v, 1) for k, v in result.speed.items()}}
        return detections, timing


def draw(img: Image.Image, detections: list[Detection]) -> Image.Image:
    out = img.copy()
    pen = ImageDraw.Draw(out)
    line = max(2, round(min(out.size) / 250))
    font = ImageFont.load_default(size=max(12, round(min(out.size) / 40)))
    palette = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45"]
    for det in detections:
        color = palette[det.class_id % len(palette)]
        x1, y1, x2, y2 = det.bbox_xyxy
        pen.rectangle((x1, y1, x2, y2), outline=color, width=line)
        label = f"{det.class_name} {det.score:.2f}"
        tx1, ty1, tx2, ty2 = pen.textbbox((x1, y1), label, font=font)
        ty_shift = (ty2 - ty1) + 2 * line if y1 - (ty2 - ty1) - 2 * line >= 0 else 0
        pen.rectangle((tx1, ty1 - ty_shift, tx2 + 2 * line, ty2 - ty_shift + line), fill=color)
        pen.text((x1 + line, y1 - ty_shift), label, fill="white", font=font)
    return out


def detection_record(path: Path, meta: dict, detections: list[Detection], timing: dict) -> dict:
    return {
        "image": path.name,
        "image_size": meta,
        "timing": timing,
        "detections": [asdict(d) for d in detections],
    }
