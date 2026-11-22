"""FastAPI app: dashboard + single-image detection API.

    uvicorn findit.app:app --host 127.0.0.1 --port 8000 --no-access-log

Images are processed in memory only; nothing is written to disk and request
content (image bytes, file names, client data) is never logged.
"""

from __future__ import annotations

import asyncio
import base64
import dataclasses
import hashlib
import io
import logging
import math
import os
import subprocess
import time
from collections import deque
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


_ENV_TRUE = {"1", "true", "on", "yes"}
_ENV_FALSE = {"0", "false", "off", "no"}
DEFAULT_LIVE_DUTY = 0.6


def env_flag(name: str, default: bool) -> bool:
    """On/off setting from the environment. Unset or empty: the default. An unrecognised value
    keeps the default (and says so in the log) instead of silently meaning "on" or crashing."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    value = raw.strip().lower()
    if value in _ENV_TRUE:
        return True
    if value in _ENV_FALSE:
        return False
    log.warning("%s=%r is not recognised (use 0/false/off/no or 1/true/on/yes); keeping %s", name, raw[:40], default)
    return default


def env_duty(name: str, default: float) -> float:
    """Share of time (0 < x <= 1) from the environment. A value that is not a number, is not finite
    or lies outside the range is ignored with a warning: a typo must neither stop the app from
    starting nor remove the protection (0 would refuse every frame, 5 would cap nothing)."""
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not (math.isfinite(value) and 0 < value <= 1):
        log.warning("%s=%r must be a number above 0 and at most 1; using %s (FINDIT_LIVE=0 switches live off)",
                    name, raw[:40], default)
        return default
    return value


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
    # Images above this many pixels are decoded at reduced size (box coordinates are mapped back
    # to the original), so a 40 MP upload does not need several full-size copies in memory.
    # Anything up to this size (e.g. 4000x3000) is analysed exactly as before.
    analysis_pixels: int = 16_000_000
    max_waiting: int = 4
    # Live camera mode (POST /api/detect/live): small JPEG frames, smaller model input,
    # and a duty-cycle cap so a live session can never keep the CPU busy all the time.
    # FINDIT_LIVE=0 switches the endpoint off.
    live_enabled: bool = field(default_factory=lambda: env_flag("FINDIT_LIVE", True))
    live_conf: float = 0.35
    live_imgsz_options: tuple[int, ...] = (320, 416, 512)
    live_max_bytes: int = 512 * 1024
    live_max_side: int = 1024
    live_max_pixels: int = 1_000_000
    # Refuse new live frames once recent live work reaches this share of the window.
    live_max_duty: float = field(default_factory=lambda: env_duty("FINDIT_LIVE_DUTY", DEFAULT_LIVE_DUTY))
    live_duty_window_s: float = 2.0
    live_max_det: int = 20
    source_url: str | None = field(default_factory=lambda: os.environ.get("FINDIT_SOURCE_URL") or None)


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, retry_ms: int | None = None):
        self.status, self.code, self.message, self.retry_ms = status, code, message, retry_ms


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
    size = f"{limit // (1024 * 1024)} MiB" if limit >= 1024 * 1024 else f"{limit // 1024} KiB"
    too_large = ApiError(413, "file_too_large", f"Image is larger than {size}.")
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
        raise ApiError(415, "invalid_image", "The file is not a readable image.") from None
    if fmt not in s.allowed_formats:
        raise ApiError(415, "unsupported_format", "Only JPEG and PNG images are supported.")
    if min(w, h) < s.min_side or max(w, h) > s.max_side or w * h > s.max_pixels:
        raise ApiError(
            413, "image_dimensions",
            f"Image must be {s.min_side}–{s.max_side} px per side and at most {s.max_pixels // 1_000_000} MP.",
        )
    try:
        img, meta = load_oriented(io.BytesIO(data), formats=(fmt,), max_pixels=s.analysis_pixels)
    except (OSError, SyntaxError, ValueError, Image.DecompressionBombError):
        raise ApiError(415, "invalid_image", "The image data is damaged or incomplete.") from None
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


def scale_detections(detections, sx: float, sy: float):
    """Map boxes found on a reduced image back to the original upright pixel frame."""
    if sx == 1 and sy == 1:
        return detections
    return [
        dataclasses.replace(d, bbox_xyxy=[round(d.bbox_xyxy[0] * sx, 1), round(d.bbox_xyxy[1] * sy, 1),
                                          round(d.bbox_xyxy[2] * sx, 1), round(d.bbox_xyxy[3] * sy, 1)])
        for d in detections
    ]


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


class LiveBudget:
    """Drop new frames once recent live work reaches `max_duty` of `window_s`.

    An admitted frame runs to completion. Called from the event loop only.
    """

    def __init__(self, max_duty: float, window_s: float, clock: Callable[[], float] = time.monotonic):
        self.max_duty, self.window_s, self.clock = max_duty, window_s, clock
        self.spans: deque[tuple[float, float]] = deque()  # (end, duration)

    def _busy(self, now: float) -> float:
        start = now - self.window_s
        while self.spans and self.spans[0][0] <= start:
            self.spans.popleft()
        return sum(min(d, end - start) for end, d in self.spans)

    def retry_after_ms(self) -> int:
        """0 when a live frame may run now, otherwise a rough wait until it may."""
        now = self.clock()
        excess = self._busy(now) - self.max_duty * self.window_s
        if excess < 0:
            return 0
        # The oldest spans leave the window first; wait at least until enough of them have.
        start, freed = now - self.window_s, 0.0
        for end, d in self.spans:
            freed += min(d, end - start)
            if freed > excess:
                return max(100, int((end - start + 0.05) * 1000))
        return int(self.window_s * 1000)

    def record(self, duration_s: float) -> None:
        self.spans.append((self.clock(), duration_s))

    def check(self) -> None:
        wait_ms = self.retry_after_ms()
        if wait_ms:
            raise ApiError(503, "busy", "Live detection is paused to protect the server.", retry_ms=wait_ms)


class InferenceGate:
    """One inference at a time; at most `max_waiting` requests queued behind it."""

    def __init__(self, max_waiting: int):
        self.lock = asyncio.Lock()
        self.max_waiting = max_waiting
        self.pending = 0

    async def try_run(self, fn: Callable, *args, budget: LiveBudget | None = None):
        """Like run(), but never waits: a live frame is dropped while anything else is
        running or queued. A live budget is checked again after reading the body."""
        if self.lock.locked() or self.pending > 0:
            raise ApiError(503, "busy", "The detector is busy. Please try again in a moment.", retry_ms=500)
        if budget is not None:
            budget.check()
        return await self.run(fn, *args, on_finish=budget.record if budget is not None else None)

    async def run(self, fn: Callable, *args, on_finish: Callable[[float], None] | None = None):
        if self.pending >= self.max_waiting + 1:
            raise ApiError(503, "busy", "The detector is busy. Please try again in a moment.")
        self.pending += 1
        try:
            async with self.lock:
                started = time.monotonic()
                fut = asyncio.ensure_future(run_in_threadpool(fn, *args))
                try:
                    return await asyncio.shield(fut)
                except asyncio.CancelledError:
                    # The client went away, but the worker thread cannot be stopped and the
                    # model is not thread-safe: keep the slot until the thread has finished.
                    while not fut.done():
                        try:
                            await asyncio.wait([fut])
                        except asyncio.CancelledError:
                            pass
                    if not fut.cancelled():
                        fut.exception()  # mark as retrieved
                    raise
                finally:
                    if on_finish is not None:
                        on_finish(time.monotonic() - started)
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
    app.state.live_budget = LiveBudget(s.live_max_duty, s.live_duty_window_s)
    live_limits = dataclasses.replace(
        s, allowed_formats=("JPEG",), max_side=s.live_max_side, max_pixels=s.live_max_pixels,
    )

    @app.exception_handler(ApiError)
    async def api_error(_: Request, exc: ApiError):
        error = {"code": exc.code, "message": exc.message}
        headers = {}
        if exc.retry_ms is not None:
            error["retry_ms"] = exc.retry_ms
            headers["Retry-After"] = str(max(1, -(-exc.retry_ms // 1000)))
        return JSONResponse({"error": error}, status_code=exc.status, headers=headers)

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
            "live": {
                "enabled": s.live_enabled,
                "imgsz": list(s.live_imgsz_options),
                "conf_threshold": s.live_conf,
                "max_frame_kib": s.live_max_bytes // 1024,
                "max_duty": s.live_max_duty,
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
            detections = scale_detections(detections, meta["width"] / img.width, meta["height"] / img.height)
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

    @app.post("/api/detect/live")
    async def detect_live(request: Request, imgsz: int | None = None):
        """One small JPEG frame from the live camera. No preview is returned and nothing is
        queued: if the detector is busy or the duty-cycle cap is reached the frame is refused
        with 503 `busy` and a retry hint, and the browser simply tries a later frame."""
        if not s.live_enabled:
            raise ApiError(404, "live_disabled", "Live detection is switched off on this server.")
        det = app.state.detector
        if det is None:
            raise ApiError(503, "model_unavailable", "The detection model is not loaded on the server.")
        size = imgsz if imgsz is not None else s.live_imgsz_options[0]
        if size not in s.live_imgsz_options:
            raise ApiError(400, "bad_parameter", f"imgsz must be one of {list(s.live_imgsz_options)}.")
        budget = app.state.live_budget
        budget.check()
        data = await read_limited(request, s.live_max_bytes)

        def work():
            t0 = time.perf_counter()
            img, meta = decode_image(data, live_limits)
            detections, timing = det.detect(img, imgsz=size, conf=s.live_conf, max_det=s.live_max_det)
            return meta, detections, timing, time.perf_counter() - t0

        meta, detections, timing, spent_s = await app.state.gate.try_run(work, budget=budget)
        server_ms = spent_s * 1000
        return {
            "image": {"width": meta["width"], "height": meta["height"]},
            "imgsz": size,
            "conf_threshold": s.live_conf,
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
