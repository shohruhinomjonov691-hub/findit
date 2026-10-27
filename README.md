# FindIt — AI Visual Object Finder

Find an everyday object in a photo and highlight it. Early stage: only the
detection feasibility check exists — no web UI, API or deployment yet.

## Status

- Detection script: image → bounding boxes, class, score and image size as JSON,
  plus an annotated JPEG. EXIF orientation is applied before detection.
- Feasibility report: [docs/feasibility-2026-10-27.md](docs/feasibility-2026-10-27.md)
  (20 images, not an accuracy benchmark).
- Model: COCO-pretrained Ultralytics YOLOv8 (no training).

## Run locally

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
curl -L -o models/yolov8n.pt https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt
shasum -a 256 models/yolov8n.pt   # compare with models/MODELS.md
.venv/bin/python -m findit.detect path/to/photo.jpg --out results/demo
```

Output per image: `results/demo/<name>.json` and `<name>.annotated.jpg`;
`results/demo/run.json` has timing and memory. Options: `--model`, `--imgsz`,
`--conf`, `--device cpu|mps`.

Tests:

```bash
.venv/bin/python -m unittest discover -s tests
```

Test set (downloaded, not committed): `python scripts/fetch_testset.py`.

## License

AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) (Ultralytics and the
YOLOv8 weights are AGPL-3.0; test image attributions are in
`data/testset_manifest.json`).
