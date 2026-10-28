# FindIt — AI Visual Object Finder

Find an everyday object in a photo and highlight it. Upload an image (or capture one
camera frame), search or filter the detected objects, select one to see a close-up,
its 3×3 position and pixel coordinates, and export the JSON or an annotated image.

Detection uses the COCO-pretrained Ultralytics **YOLOv8s** model as-is (80 classes,
no training). The score shown is the model's confidence, not a guarantee; objects
can be missed, and only the 80 COCO classes can be found at all.

## Status

- Find & Highlight MVP on branch `develop`, runs locally. No deployment and no
  public repository yet; Compare Mode is not built.
- Feasibility check (20 images, not an accuracy benchmark):
  [docs/feasibility-2026-10-27.md](docs/feasibility-2026-10-27.md). MVP plan:
  [docs/mvp-plan.md](docs/mvp-plan.md).

## Run locally

```bash
python3.13 -m venv .venv
.venv/bin/pip install -r requirements.lock.txt
curl -L -o models/yolov8s.pt https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.pt
shasum -a 256 models/yolov8s.pt   # compare with models/MODELS.md
.venv/bin/uvicorn findit.app:app --host 127.0.0.1 --port 8765 --no-access-log
```

Open http://127.0.0.1:8765. The camera works on `localhost`/`127.0.0.1` or HTTPS.

Environment variables:

| Name | Default | Meaning |
| --- | --- | --- |
| `FINDIT_MODEL` | `models/yolov8s.pt` | local weights file; URLs and missing files are refused (no download) |
| `FINDIT_SOURCE_URL` | unset | public source link shown on the Source page (AGPL §13); unset shows "not published" |

## API

| Route | Description |
| --- | --- |
| `POST /api/detect` | raw image bytes as the request body (`Content-Type: image/*`) → upright image size, EXIF orientation, JPEG preview of the same upright image, detections (`bbox_xyxy` in upright pixels, `score`, `area_px`, `center`, 3×3 `cell`), `timing.inference_ms` and `timing.server_ms` |
| `GET /api/info` | model file, SHA-256, classes, threshold, limits, source link and local commit |
| `GET /api/health` | liveness and whether the model is loaded |

Limits: JPEG/PNG/WebP only (checked by decoding, not by extension), ≤ 10 MiB,
16–12000 px per side, ≤ 40 MP. One inference runs at a time; at most 4 requests
wait, later ones get `503 busy`.

Privacy: images are processed in memory and never written to disk. The app logs no
image data, file names or client data; start uvicorn with `--no-access-log` so the
server does not log client addresses either.

## Detection CLI and tests

```bash
.venv/bin/python -m findit.detect path/to/photo.jpg --model models/yolov8s.pt --out results/demo
.venv/bin/python -m unittest discover -s tests
```

`tests/test_integration.py` runs the real model and is skipped unless the weights
and the git-ignored test images (`python scripts/fetch_testset.py`) exist.

## License

AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Ultralytics and the
YOLOv8 weights are AGPL-3.0; if FindIt is offered over a network, set
`FINDIT_SOURCE_URL` to the public source of the running commit.
