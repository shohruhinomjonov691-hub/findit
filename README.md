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
| `FINDIT_COMMIT` | `git describe` of the checkout | commit shown on the Source page; set by the Docker build, where there is no `.git` |

## Deployment

Not deployed. Docker/Compose/Nginx files and a runbook are in [deploy/](deploy/README.md);
the YOLOv8s weights are mounted read-only from the host and never enter the image or git.

## API

| Route | Description |
| --- | --- |
| `POST /api/detect` | raw image bytes as the request body (`Content-Type: image/*`) → upright image size, EXIF orientation, JPEG preview of the same upright image, detections (`bbox_xyxy` in upright pixels, `score`, `area_px`, `center`, 3×3 `cell`), `timing.inference_ms` and `timing.server_ms` |
| `GET /api/info` | model file, SHA-256, classes, threshold, limits, source link and local commit |
| `GET /api/health` | liveness and whether the model is loaded |

Limits: JPEG and PNG only, recognized from the file's leading bytes before any
decoder runs (not from the extension or `Content-Type`); WebP is refused because its
decoder allocates the full canvas before size limits can be checked. Animated PNGs
are accepted and only the first frame is analysed. ≤ 10 MiB,
16–12000 px per side, ≤ 40 MP. One inference runs at a time; at most 4 requests
wait, later ones get `503 busy`.

Search matches only a full class name (English or Korean) or a listed synonym, so an
unsupported object such as "tablet" is reported as not supported instead of being
mapped to a similar class.

Privacy: images are processed in memory and never written to disk. The app logs no
image data, file names, client data or exception messages (unexpected request errors are
logged only as `server_error`); start uvicorn with `--no-access-log` so the
server does not log client addresses either.

## Detection CLI and tests

```bash
.venv/bin/python -m findit.detect path/to/photo.jpg --model models/yolov8s.pt --out results/demo
.venv/bin/python -m unittest discover -s tests
node --test tests/js/*.test.mjs
```

- `tests/test_app.py`: API with a stub detector (limits, formats, EXIF frame, busy,
  errors, no disk spooling of the current endpoint).
- `tests/test_uvicorn_errors.py`: starts a real Uvicorn server and checks that a 500
  keeps the security headers and that the exception text never reaches the log.
- `tests/test_integration.py`: real YOLOv8s on a test image; skipped unless the
  weights and the git-ignored test images (`python scripts/fetch_testset.py`) exist.
- `tests/js/`: Node tests (no dependencies). `camera.test.mjs` and `search.test.mjs`
  unit-test `findit/web/camera.js` and `search.js`; `app-camera.test.mjs` loads the
  real `app.js` with a minimal fake DOM and drives the camera dialog through its own
  listeners, delivering the dialog's "close" event late as browsers do. They use fake
  streams and a fake DOM, not a browser.

## License

AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Ultralytics and the
YOLOv8 weights are AGPL-3.0; if FindIt is offered over a network, set
`FINDIT_SOURCE_URL` to the public source of the running commit.
