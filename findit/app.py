"""FastAPI app: dashboard + single-image detection API.

    uvicorn findit.app:app --host 127.0.0.1 --port 8000 --no-access-log

Images are processed in memory only; nothing is written to disk and request
content (image bytes, file names, client data) is never logged.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import logging
import os
import subprocess
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from starlette.concurrency import run_in_threadpool

from findit.detector import load_oriented, pil_open

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = Path(__file__).resolve().parent / "web"
log = logging.getLogger("findit")


@dataclass
class Settings:
    model_path: Path = field(default_factory=lambda: Path(os.environ.get("FINDIT_MODEL", ROOT / "models" / "yolov8s.pt")))
    conf: float = 0.25
    imgsz: int = 640
    device: str = "cpu"
    max_upload_bytes: int = 10 * 1024 * 1024
    max_pixels: int = 40_000_000
    min_side: int = 16
    max_side: int = 12_000
    # WebP is not accepted: its decoder allocates the full canvas while the file is
    # being opened, before the limits below can be checked.
    allowed_formats: tuple[str, ...] = ("JPEG", "PNG")
    preview_max_side: int = 2048
    max_waiting: int = 4
    source_url: str | None = field(default_factory=lambda: os.environ.get("FINDIT_SOURCE_URL") or None)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message


def git_commit() -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "describe", "--always", "--dirty", "--abbrev=7"],
            capture_output=True, text=True, timeout=2, check=True,
        )
        return out.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


async def read_limited(request: Request, limit: int) -> bytes:
    """Read the raw request body in memory; raise 413 as soon as it exceeds `limit`.

    The image is sent as the request body, not as multipart form data: Starlette's
    multipart parser reads the whole upload before the handler runs and spools parts
    above 1 MiB to a temporary file on disk.
    """
    too_large = ApiError(413, "file_too_large", f"Image is larger than {limit // (1024 * 1024)} MiB.")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > limit:
        raise too_large
    chunks, total = [], 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > limit:
            raise too_large
        chunks.append(chunk)
    if total == 0:
        raise ApiError(400, "empty_file", "No image data received.")
    return b"".join(chunks)


# Leading bytes of accepted formats, and of common image formats that are refused.
SIGNATURES = {"JPEG": (b"\xff\xd8\xff",), "PNG": (b"\x89PNG\r\n\x1a\n",)}
REFUSED_SIGNATURES = (b"RIFF", b"GIF87a", b"GIF89a", b"BM", b"II*\x00", b"MM\x00*", b"\x00\x00\x00\x0cjP")


def sniff_format(data: bytes) -> str:
    """Decide the format from the leading bytes, before any Pillow decoder is created."""
    for fmt, prefixes in SIGNATURES.items():
        if data.startswith(prefixes):
            return fmt
    if data.startswith(REFUSED_SIGNATURES) or data[4:8] == b"ftyp":  # WebP/GIF/BMP/TIFF/JPEG 2000/HEIC/AVIF
        raise ApiError(415, "unsupported_format", "Only JPEG and PNG images are supported.")
    raise ApiError(415, "invalid_image", "The file is not a readable image.")


def decode_image(data: bytes, s: Settings) -> tuple[Image.Image, dict]:
    """Validate the bytes as a real image within limits; return the upright RGB image.

    Opening a JPEG/PNG only parses headers, so the size limits are checked before
    pixel data is decoded. Animated PNGs are accepted and only the first frame is used.
    """
    fmt = sniff_format(data)
    if fmt not in s.allowed_formats:
        raise ApiError(415, "unsupported_format", "Only JPEG and PNG images are supported.")
    try:
        with pil_open(io.BytesIO(data), formats=[fmt]) as probe:
            fmt, (w, h) = probe.format, probe.size
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise ApiError(415, "invalid_image", "The file is not a readable image.")
    if fmt not in s.allowed_formats:
        raise ApiError(415, "unsupported_format", "Only JPEG and PNG images are supported.")
    if min(w, h) < s.min_side or max(w, h) > s.max_side or w * h > s.max_pixels:
        raise ApiError(
            413, "image_dimensions",
            f"Image must be {s.min_side}–{s.max_side} px per side and at most {s.max_pixels // 1_000_000} MP.",
        )
    try:
        img, meta = load_oriented(io.BytesIO(data), formats=(fmt,))
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise ApiError(415, "invalid_image", "The image data is damaged or incomplete.")
    meta["format"] = fmt
    return img, meta


def preview_data_url(img: Image.Image, max_side: int) -> tuple[str, list[int]]:
    """JPEG of the same upright image the boxes refer to, scaled down for the browser."""
    preview = img.copy()
    preview.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    preview.save(buf, format="JPEG", quality=88)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii"), [preview.width, preview.height]


def grid_cell(cx: float, cy: float, w: int, h: int) -> dict:
    col = min(2, int(3 * cx / w))
    row = min(2, int(3 * cy / h))
    return {"row": row, "col": col}


def detection_payload(detections, width: int, height: int) -> list[dict]:
    items = []
    for d in sorted(detections, key=lambda d: d.score, reverse=True):
        x1, y1, x2, y2 = d.bbox_xyxy
        x1, x2 = max(0.0, x1), min(float(width), x2)
        y1, y2 = max(0.0, y1), min(float(height), y2)
        area = max(0.0, x2 - x1) * max(0.0, y2 - y1)
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        items.append({
            "id": len(items),
            "class_id": d.class_id,
            "class_name": d.class_name,
            "score": d.score,
            "bbox_xyxy": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "area_px": round(area, 1),
            "area_fraction": round(area / (width * height), 5),
            "center": [round(cx, 1), round(cy, 1)],
            "cell": grid_cell(cx, cy, width, height),
        })
    return items


class InferenceGate:
    """One inference at a time; at most `max_waiting` requests queued behind it."""

    def __init__(self, max_waiting: int):
        self.lock = asyncio.Lock()
        self.max_waiting = max_waiting
        self.pending = 0

    async def run(self, fn: Callable, *args):
        if self.pending >= self.max_waiting + 1:
            raise ApiError(503, "busy", "The detector is busy. Please try again in a moment.")
        self.pending += 1
        try:
            async with self.lock:
                return await run_in_threadpool(fn, *args)
        finally:
            self.pending -= 1


def default_detector_factory(s: Settings):
    from findit.detector import Detector

    return Detector(s.model_path, imgsz=s.imgsz, conf=s.conf, device=s.device, agnostic_nms=True)


def create_app(settings: Settings | None = None, detector_factory: Callable | None = None) -> FastAPI:
    s = settings or Settings()
    factory = detector_factory or default_detector_factory

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        state = app.state
        state.detector, state.model_error, state.model_sha256 = None, None, None
        try:
            state.detector = await run_in_threadpool(factory, s)
            state.model_sha256 = sha256_file(Path(state.detector.model_path))
            log.info("model loaded: %s", Path(state.detector.model_path).name)
        except Exception as exc:  # the UI stays up and reports the model as unavailable
            state.model_error = type(exc).__name__
            log.error("model not loaded: %s", exc)
        # The container image has no .git; the build passes the commit in FINDIT_COMMIT.
        state.commit = os.environ.get("FINDIT_COMMIT") or git_commit()
        yield

    app = FastAPI(title="FindIt", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.gate = InferenceGate(s.max_waiting)
    app.state.settings = s

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)


    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        # Unexpected errors are turned into a response here, inside the app. An
        # @exception_handler(Exception) would run in Starlette's ServerErrorMiddleware,
        # which re-raises afterwards: Uvicorn then logs the traceback (exception
        # message included) and the response skips this middleware's headers.
        try:
            response = await call_next(request)
        except Exception:
            log.error("request failed: server_error")
            response = JSONResponse(
                {"error": {"code": "server_error", "message": "Internal server error."}}, status_code=500
            )
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
            "style-src 'self'; script-src 'self'; connect-src 'self'; "
            "frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        )
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        else:
            # Revalidate the page and its scripts on every load (ETag/Last-Modified), so an
            # updated index.html is never combined with an old cached app.js.
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "model_loaded": app.state.detector is not None}

    @app.get("/api/info")
    async def info():
        det = app.state.detector
        return {
            "model": {
                "file": Path(det.model_path).name if det else Path(s.model_path).name,
                "sha256": app.state.model_sha256,
                "loaded": det is not None,
                "error": app.state.model_error,
                "classes": [det.class_names[i] for i in sorted(det.class_names)] if det else [],
                "conf_threshold": s.conf,
                "imgsz": s.imgsz,
                "device": s.device,
                "agnostic_nms": True,
            },
            "limits": {
                "max_upload_mib": s.max_upload_bytes // (1024 * 1024),
                "max_megapixels": s.max_pixels // 1_000_000,
                "min_side": s.min_side,
                "max_side": s.max_side,
                "formats": list(s.allowed_formats),
            },
            "source": {"url": s.source_url, "commit": app.state.commit, "license": "AGPL-3.0"},
        }

    @app.post("/api/detect")
    async def detect(request: Request):
        det = app.state.detector
        if det is None:
            raise ApiError(503, "model_unavailable", "The detection model is not loaded on the server.")
        data = await read_limited(request, s.max_upload_bytes)

        def work():
            t0 = time.perf_counter()
            img, meta = decode_image(data, s)
            detections, timing = det.detect(img)
            preview, preview_size = preview_data_url(img, s.preview_max_side)
            return img, meta, detections, timing, preview, preview_size, (time.perf_counter() - t0) * 1000

        img, meta, detections, timing, preview, preview_size, server_ms = await app.state.gate.run(work)
        return {
            "model": Path(det.model_path).name,
            "conf_threshold": s.conf,
            "image": {
                "width": meta["width"],
                "height": meta["height"],
                "raw_width": meta["raw_width"],
                "raw_height": meta["raw_height"],
                "exif_orientation": meta["exif_orientation"],
                "format": meta["format"],
            },
            "preview": {"data_url": preview, "width": preview_size[0], "height": preview_size[1]},
            "detections": detection_payload(detections, meta["width"], meta["height"]),
            "timing": {"inference_ms": timing["wall_ms"], "server_ms": round(server_ms, 1)},
        }

    @app.get("/")
    async def index():
        return FileResponse(WEB_DIR / "index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
