# FindIt — AI Visual Object Finder

Find an everyday object in a photo and highlight it. Upload an image (or capture one
camera frame), search or filter the detected objects, select one to see a close-up,
its 3×3 position and pixel coordinates, and export the JSON or an annotated image.
**Live camera** names objects continuously (name, confidence %, position) and can read
them aloud in the UI language (EN / KO) or stay muted.

Detection uses the COCO-pretrained Ultralytics **YOLOv8s** model as-is (80 classes,
no training). The score shown is the model's confidence, not a guarantee; objects
can be missed, and only the 80 COCO classes can be found at all.

## Status

- Find & Highlight MVP plus Live camera and voice output (added 2026-11-19) on branch
  `develop`, runs locally. No deployment and no public repository yet; Compare Mode is
  not built.
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
| `FINDIT_LIVE` | `1` | `0`, `false`, `off` or `no` switch the live endpoint off (the Live page then reports it); `1`, `true`, `on`, `yes` keep it on; any other value keeps it on and logs a warning |
| `FINDIT_LIVE_DUTY` | `0.6` (`0.35` in `compose.yaml`, recommended for the shared server) | refuse new live frames when work reaches this share of the last 2 s; above 0 and at most 1. Anything else (text, `0`, `5`, `nan`) is ignored with a warning and `0.6` is used, so a typo can neither stop the app nor remove the limit |

## Live camera and voice

Open **Live camera**, press *Start live* and allow the camera (HTTPS or `localhost`).

- **Per object on screen:** name, confidence % and position (3×3: "Middle right", …),
  drawn over the video; the same list sits in the side panel.
- **Status:** `Live Active (Fast / Balanced / Low-Power)` with `FPS` and `Latency (ms)`;
  speed mode is *Auto* (steps down when the server is slow or busy, up after a long run
  of quick answers) or pinned. Boxes are steadied across frames (overlap matching,
  smoothing, a box appears after 2 frames unless confident, and disappears only after
  2 empty frames), so they do not blink.
- **Voice:** `Voice ON (EN)` / `Voice ON (KO)` says e.g. "90% cup on the right, 97% book
  on the left" / "오른쪽에 컵 90%, 왼쪽에 책 97%" (at most 2 objects per sentence, the
  same object not again for 8 s). `Voice OFF (Muted)` shows everything on screen only.
  `Voice Unavailable` appears when the browser has no speech output, no voice for the
  UI language, or fails to speak; the picture keeps working. Speech uses the browser's
  own `speechSynthesis` (no microphone, nothing sent anywhere). A natural installed voice
  is chosen for the language (default and local voices first, novelty voices avoided).
  **Test voice** says a sample sentence ("90% cup on the right" / "오른쪽에 컵 90%") in the
  UI language even while muted, which shows whether this browser, voice and volume work.
  A line under the switch says what the voice is doing: `Last said: “…”`, "waiting for a new
  object to announce", or "no object is above NN% yet, so there is nothing to say" (voice is
  only about objects that pass **Minimum confidence**); if the browser blocks sound until
  the page is clicked, it asks to click **Test voice** or the switch.
- **Accuracy and boxes:** frames are 416 px (Fast) or 512 px (Balanced, Low-Power) with JPEG
  quality 0.8–0.85; on 20 photos against a 1280×960 reference this found 78 % of the reference
  objects at 512 px / 0.85 versus 62 % at 320 px / 0.6 (a proxy, not a benchmark: no labelled
  ground truth, 45 reference objects). The model's box size matched the reference (area ratio
  1.0), so "too wide" boxes come from elsewhere: moving objects (the answer is 100–300 ms old)
  and large low-confidence context boxes. Hence: boxes follow fast movement almost fully and are
  moved on by the object's measured speed every animation frame, for at most 0.4 s and not
  at all while the picture is still and frames are skipped (panning at 20 px/frame:
  displayed box IoU 0.77 → 0.89; at 40 px/frame 0.61 → 0.86; still scenes unchanged at 0.98),
  a box disappears after 2 empty frames, and a **Minimum confidence** slider (default 45 %,
  35–80 %) hides weak boxes, while a box covering more than half of the frame needs ≥ 70 %
  (on the 20 photos: wrong boxes 0.85 → 0.40 per image, recall 0.78 → 0.73).
- **Language:** the `EN | KO` switch is at the top of the sidebar and again at the top of the
  Live panel; it changes all texts, the object names and the spoken language together.
- **Server load:** a frame is a ≤ 512 px JPEG (≈ 15–35 KiB) sent only after the previous
  answer arrived; a picture that did not change is not sent (only a 1.5 s heartbeat);
  the tab hidden pauses it; it stops after 5 minutes. Server side the endpoint never
  queues (a frame is refused with `503 busy` while the detector is occupied or an upload is
  waiting), applies `FINDIT_LIVE_DUTY` before admitting each frame, skips the preview and uses the
  model at 416/512 px instead of 640.
- **Limits:** only the 80 COCO classes exist, so there is **no `pen` or `flower` class**
  (closest: `vase`, `potted plant`); `phone` is `cell phone`. Small input sizes lose
  detail: an upload (640 px, full photo) still sees more than a live frame does. The
  first answer of a session is slower (model warm-up) and is ignored when Auto picks a speed. Left/right is as the camera sees it (not mirrored).

## Deployment

Runs in Docker (container `findit`) behind Nginx at https://findit.gotrips.cloud. The
Docker/Compose/Nginx files and the update runbook are in [deploy/](deploy/README.md);
the YOLOv8s weights are mounted read-only from the host and never enter the image or git.

## API

| Route | Description |
| --- | --- |
| `POST /api/detect` | raw image bytes as the request body (`Content-Type: image/*`) → upright image size, EXIF orientation, JPEG preview of the same upright image, detections (`bbox_xyxy` in upright pixels, `score`, `area_px`, `center`, 3×3 `cell`), `timing.inference_ms` and `timing.server_ms` |
| `POST /api/detect/live?imgsz=320\|416\|512` | one small JPEG frame (≤ 512 KiB, ≤ 1 MP, JPEG only) → image size and detections (same fields as `/api/detect`, threshold 0.35, ≤ 20 boxes), no preview. Never queued: `503 busy` with `Retry-After` and `retry_ms` while the detector is busy or the duty cap is reached; `404 live_disabled` when switched off |
| `GET /api/info` | model file, SHA-256, classes, threshold, limits, `live` options, source link and local commit |
| `GET /api/health` | liveness and whether the model is loaded |

Limits: JPEG and PNG only, recognized from the file's leading bytes before any
decoder runs (not from the extension or `Content-Type`); WebP is refused because its
decoder allocates the full canvas before size limits can be checked. Animated PNGs
are accepted and only the first frame is analysed. ≤ 10 MiB,
16–12000 px per side, ≤ 40 MP. Images above 16 MP are decoded at reduced size (JPEG: decoder
scaling; PNG: reduced right after loading) and the boxes are mapped back, so the reported
coordinates stay in the original frame; a 39 MP JPEG peaks at +130 MiB over the idle model
instead of +749 MiB (dev Mac measurement). Images up to 16 MP are analysed exactly as before. One inference runs at a time; at most 4 requests
wait, later ones get `503 busy`.

Search matches only a full class name (English or Korean) or a listed synonym, so an
unsupported object such as "tablet" is reported as not supported instead of being
mapped to a similar class.

Privacy: images are processed in memory and never written to disk. The app logs no
image data, file names, client data or exception messages (unexpected request errors are
logged only as `server_error`); start uvicorn with `--no-access-log` so the
server does not log client addresses either. In the deployment Nginx templates access
logging is off, but the Nginx error log is kept and may record client metadata (IP
address, request line, host) when an error occurs; see [deploy/README.md](deploy/README.md).

## Detection CLI and tests

```bash
.venv/bin/python -m findit.detect path/to/photo.jpg --model models/yolov8s.pt --out results/demo
.venv/bin/python -m unittest discover -s tests
node --test tests/js/*.test.mjs
```

- `tests/test_app.py`: API with a stub detector (limits, formats, EXIF frame, busy,
  errors, no disk spooling of the current endpoint).
- `tests/test_live.py`: live endpoint (limits, JPEG only, busy/duty cap, disabled), the
  duty-cycle budget and the inference gate when a client cancels a request.
- `tests/test_uvicorn_errors.py`: starts a real Uvicorn server and checks that a 500
  keeps the security headers and that the exception text never reaches the log.
- `tests/test_integration.py`: real YOLOv8s on a test image; skipped unless the
  weights and the git-ignored test images (`python scripts/fetch_testset.py`) exist.
- `tests/js/`: Node tests (no dependencies). `camera.test.mjs` and `search.test.mjs`
  unit-test `findit/web/camera.js` and `search.js`; `app-camera.test.mjs` loads the
  real `app.js` with a minimal fake DOM and drives the camera dialog through its own
  listeners, delivering the dialog's "close" event late as browsers do. They use fake
  streams and a fake DOM, not a browser. `live.test.mjs` / `voice.test.mjs` unit-test
  the frame steadying, speed governor, motion gate and speech rules; `app-live.test.mjs`
  drives the Live page, voice (EN/KO, mute, unavailable) and the upload/export states
  through the real `app.js` with fake camera, speech and fetch and a virtual clock.

## License

AGPL-3.0 — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Ultralytics and the
YOLOv8 weights are AGPL-3.0; if FindIt is offered over a network, set
`FINDIT_SOURCE_URL` to the public source of the running commit.
