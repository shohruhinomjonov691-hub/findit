"""CLI: python -m findit.detect IMAGE_OR_DIR [...] --out results/run

Writes <name>.json and <name>.annotated.jpg per image, plus run.json with
model, device, cold-start/warm timing and peak RSS.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import resource
import statistics
import sys
import time
from pathlib import Path

import psutil

from findit.detector import Detector, detection_record, draw, load_oriented

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def collect(paths: list[str]) -> list[Path]:
    files: list[Path] = []
    for p in map(Path, paths):
        if p.is_dir():
            files += sorted(f for f in p.iterdir() if f.suffix.lower() in IMAGE_EXTS)
        else:
            files.append(p)
    return files


def peak_rss_mb() -> float:
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes, Linux reports kilobytes.
    return round(peak / (1024 * 1024 if sys.platform == "darwin" else 1024), 1)


def main() -> None:
    t_start = time.perf_counter()
    ap = argparse.ArgumentParser()
    ap.add_argument("inputs", nargs="+")
    ap.add_argument("--model", default="models/yolov8n.pt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--conf", type=float, default=0.25)
    ap.add_argument("--device", default="cpu")
    args = ap.parse_args()

    files = collect(args.inputs)
    if not files:
        sys.exit("no images found")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    proc = psutil.Process()
    rss_before_model = proc.memory_info().rss
    detector = Detector(Path(args.model), imgsz=args.imgsz, conf=args.conf, device=args.device)
    rss_after_model = proc.memory_info().rss

    per_image = []
    for i, path in enumerate(files):
        img, meta = load_oriented(path)
        detections, timing = detector.detect(img)
        record = detection_record(path, meta, detections, timing)
        (out_dir / f"{path.stem}.json").write_text(json.dumps(record, indent=2))
        draw(img, detections).save(out_dir / f"{path.stem}.annotated.jpg", quality=90)
        per_image.append({"image": path.name, "first": i == 0, **timing, "n": len(detections)})
        found = ", ".join(f"{d.class_name}:{d.score:.2f}" for d in detections) or "-"
        print(f"{path.name:<32} {meta['width']}x{meta['height']:<6} {timing['wall_ms']:>7.1f} ms  {found}")

    warm = [r["wall_ms"] for r in per_image[1:]]
    run = {
        "model": str(detector.model_path),
        "model_sha256": hashlib.sha256(detector.model_path.read_bytes()).hexdigest(),
        "imgsz": args.imgsz,
        "conf": args.conf,
        "device": args.device,
        "machine": {"platform": platform.platform(), "processor": platform.processor(), "python": platform.python_version()},
        "images": len(files),
        "ultralytics_import_s": round(detector.import_seconds, 3),
        "model_load_s": round(detector.load_seconds, 3),
        "first_inference_ms": per_image[0]["wall_ms"],
        "warm_inference_ms": {
            "median": round(statistics.median(warm), 1) if warm else None,
            "min": min(warm, default=None),
            "max": max(warm, default=None),
        },
        "rss_mb": {
            "before_model": round(rss_before_model / 2**20, 1),
            "after_model": round(rss_after_model / 2**20, 1),
            "end": round(proc.memory_info().rss / 2**20, 1),
            "peak": peak_rss_mb(),
        },
        "process_wall_s": round(time.perf_counter() - t_start, 2),
        "per_image": per_image,
    }
    (out_dir / "run.json").write_text(json.dumps(run, indent=2))
    print(json.dumps({k: v for k, v in run.items() if k != "per_image"}, indent=2))


if __name__ == "__main__":
    main()
