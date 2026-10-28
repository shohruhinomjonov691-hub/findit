# Find & Highlight MVP — implementation plan (2026-10-28)

Branch `develop` from `main` @ `23a494f`. Compare Mode, training, paid APIs, push and
deploy are out of scope.

## Stack

- **Backend:** FastAPI + uvicorn, reusing `findit.detector.Detector` with YOLOv8s
  (local weights only, loaded once at start-up, class-agnostic NMS).
- **Frontend:** plain HTML/CSS/JS served by FastAPI. No build step and no JS framework:
  the app is one page with a few views, so React/Tailwind would add tooling without
  adding capability.

## API

| Route | Purpose |
| --- | --- |
| `GET /` | dashboard |
| `GET /api/info` | model file, SHA-256, classes, threshold, limits, source link (or "not published") |
| `POST /api/detect` | one image as the raw request body → upright preview + detections |
| `GET /api/health` | liveness + model loaded |

`/api/detect` response: upright image size and EXIF orientation, a JPEG preview of the
*same* upright image (data URL, longest side ≤ 2048 px), detections in upright pixel
coordinates with area, center and 3×3 cell, and server-measured inference time.

## Safety limits

- Upload ≤ 10 MiB as raw body (streamed, stops at limit; no multipart spooling to disk), ≤ 40 MP, sides 16–12000 px,
  JPEG/PNG/WebP only, decoded with Pillow (content decides, not the extension).
- One inference at a time (asyncio lock); at most 4 requests waiting, then `503 busy`.
- No image is written to disk; no file names, image data or client data in logs;
  run uvicorn with `--no-access-log`.

## UI (per approved dark dashboard)

Finder · Inspect & Export · How it works · Model details · Supported objects · Source;
EN/KO; search by name (EN/KO), class filter, sort by score / name / area; select via
list or box → highlight, dim others, crop preview, 3×3 location, optional speech;
toggles for labels / scores / coordinates; JSON view, copy, download; annotated PNG
download; camera single-frame capture on click; empty / loading / not found / invalid
image / camera denied / busy / server error states; keyboard navigation; mobile layout.

## Tests

- unittest + FastAPI TestClient with a stub detector: limits, invalid files, EXIF
  frame, response shape, grid cells, busy handling, nothing written to disk, logs.
- One integration test with the real YOLOv8s on a local test image (skipped if
  weights or image are missing).
- Browser checks in the built-in browser: desktop + mobile width, states, keyboard.
