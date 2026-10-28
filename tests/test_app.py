"""API tests with a stub detector: no model import, download or inference."""

import asyncio
import base64
import io
import logging
import os
import tempfile
import threading
import unittest
import unittest.mock
from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from findit.app import InferenceGate, ApiError, Settings, create_app, grid_cell
from findit.detector import EXIF_ORIENTATION_TAG, Detection


class StubDetector:
    def __init__(self, model_path, detections=None):
        self.model_path = model_path
        self.class_names = {0: "person", 67: "cell phone"}
        self.detections = detections if detections is not None else []
        self.seen_sizes = []

    def detect(self, img):
        self.seen_sizes.append(img.size)
        return list(self.detections), {"wall_ms": 12.3}


def image_bytes(size=(200, 100), fmt="JPEG", orientation=None):
    img = Image.new("RGB", size, "white")
    buf = io.BytesIO()
    kwargs = {}
    if orientation:
        exif = Image.Exif()
        exif[EXIF_ORIENTATION_TAG] = orientation
        kwargs["exif"] = exif
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


class ClientMixin:
    def make_client(self, detections=None, settings=None, fail=False):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        weights = Path(tmp.name) / "stub.pt"
        weights.write_bytes(b"stub")
        s = settings or Settings(model_path=weights)
        s.model_path = weights
        self.stub = StubDetector(weights, detections)

        def factory(_):
            if fail:
                raise FileNotFoundError("weights missing")
            return self.stub

        client = TestClient(create_app(s, factory), raise_server_exceptions=False)
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, client, data, name="photo.jpg", ctype="image/jpeg"):
        return client.post("/api/detect", content=data, headers={"Content-Type": ctype, "X-File-Name": name})


class AppTest(ClientMixin, unittest.TestCase):

    def test_detect_returns_upright_frame_and_boxes(self):
        det = Detection(67, "cell phone", 0.91, [10.0, 20.0, 40.0, 80.0])
        client = self.make_client([det])
        # Stored 200x100 with orientation 6 -> upright 100x200.
        r = self.post(client, image_bytes((200, 100), orientation=6))
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual((body["image"]["width"], body["image"]["height"]), (100, 200))
        self.assertEqual(body["image"]["exif_orientation"], 6)
        self.assertEqual(self.stub.seen_sizes, [(100, 200)])
        prev = body["preview"]
        self.assertEqual((prev["width"], prev["height"]), (100, 200))
        decoded = Image.open(io.BytesIO(base64.b64decode(prev["data_url"].split(",", 1)[1])))
        self.assertEqual(decoded.size, (100, 200))
        d = body["detections"][0]
        self.assertEqual(d["bbox_xyxy"], [10.0, 20.0, 40.0, 80.0])
        self.assertEqual(d["area_px"], 1800.0)
        self.assertEqual(d["center"], [25.0, 50.0])
        self.assertEqual(d["cell"], {"row": 0, "col": 0})
        self.assertEqual(body["timing"]["inference_ms"], 12.3)
        self.assertEqual(r.headers["cache-control"], "no-store")

    def test_preview_is_scaled_but_keeps_aspect(self):
        client = self.make_client(settings=Settings(preview_max_side=50))
        body = self.post(client, image_bytes((400, 200))).json()
        self.assertEqual((body["image"]["width"], body["image"]["height"]), (400, 200))
        self.assertEqual((body["preview"]["width"], body["preview"]["height"]), (50, 25))

    def test_boxes_are_clipped_and_sorted_by_score(self):
        dets = [
            Detection(0, "person", 0.4, [-5.0, -5.0, 50.0, 50.0]),
            Detection(67, "cell phone", 0.9, [150.0, 60.0, 260.0, 120.0]),
        ]
        body = self.post(self.make_client(dets), image_bytes((200, 100))).json()
        self.assertEqual([d["class_name"] for d in body["detections"]], ["cell phone", "person"])
        self.assertEqual(body["detections"][0]["bbox_xyxy"], [150.0, 60.0, 200.0, 100.0])
        self.assertEqual(body["detections"][1]["bbox_xyxy"], [0.0, 0.0, 50.0, 50.0])
        self.assertEqual([d["id"] for d in body["detections"]], [0, 1])

    def test_png_accepted(self):
        self.assertEqual(self.post(self.make_client(), image_bytes(fmt="PNG"), ctype="image/png").status_code, 200)

    def test_rejects_non_image_with_image_name(self):
        r = self.post(self.make_client(), b"not an image at all" * 10, name="x.jpg")
        self.assertEqual(r.status_code, 415)
        self.assertEqual(r.json()["error"]["code"], "invalid_image")

    def test_rejects_unsupported_format(self):
        r = self.post(self.make_client(), image_bytes(fmt="GIF"), name="a.gif", ctype="image/gif")
        self.assertEqual(r.json()["error"]["code"], "unsupported_format")

    def test_rejects_truncated_image(self):
        data = image_bytes((300, 300))
        r = self.post(self.make_client(), data[: len(data) // 2])
        self.assertEqual(r.status_code, 415)

    def test_rejects_too_large_upload(self):
        client = self.make_client(settings=Settings(max_upload_bytes=1000))
        r = self.post(client, b"\xff" * 1001)
        self.assertEqual(r.status_code, 413)
        self.assertEqual(r.json()["error"]["code"], "file_too_large")

    def test_rejects_empty_upload(self):
        self.assertEqual(self.post(self.make_client(), b"").json()["error"]["code"], "empty_file")

    def test_rejects_pixel_limits(self):
        client = self.make_client(settings=Settings(max_pixels=10_000))
        self.assertEqual(self.post(client, image_bytes((200, 100))).json()["error"]["code"], "image_dimensions")
        client = self.make_client()
        self.assertEqual(self.post(client, image_bytes((8, 8))).json()["error"]["code"], "image_dimensions")
        self.assertEqual(self.stub.seen_sizes, [])

    def test_model_unavailable(self):
        client = self.make_client(fail=True)
        r = self.post(client, image_bytes())
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["error"]["code"], "model_unavailable")
        info = client.get("/api/info").json()
        self.assertFalse(info["model"]["loaded"])
        self.assertEqual(info["model"]["error"], "FileNotFoundError")

    def test_info_reports_model_and_source(self):
        client = self.make_client()
        info = client.get("/api/info").json()
        self.assertTrue(info["model"]["loaded"])
        self.assertEqual(info["model"]["classes"], ["person", "cell phone"])
        self.assertEqual(len(info["model"]["sha256"]), 64)
        self.assertIsNone(info["source"]["url"])
        self.assertEqual(info["source"]["license"], "AGPL-3.0")

    def test_index_and_security_headers(self):
        r = self.make_client().get("/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("script-src 'self'", r.headers["content-security-policy"])
        self.assertEqual(r.headers["x-content-type-options"], "nosniff")

    def test_no_files_written_and_no_request_data_logged(self):
        client = self.make_client([Detection(0, "person", 0.5, [0.0, 0.0, 10.0, 10.0])])
        tmpdir = Path(tempfile.gettempdir())
        before = set(tmpdir.iterdir())
        with self.assertLogs(level=logging.DEBUG) as logs:
            logging.getLogger("findit").debug("marker")
            r = self.post(client, image_bytes(), name="private-name-123.jpg")
        self.assertEqual(r.status_code, 200)
        self.assertNotIn("private-name-123", "\n".join(logs.output))
        self.assertEqual(set(tmpdir.iterdir()) - before, set())
        self.assertNotIn("private-name-123", r.text)


class GateTest(unittest.TestCase):
    def test_rejects_when_queue_full(self):
        async def scenario():
            gate = InferenceGate(max_waiting=1)
            release = threading.Event()
            running = [asyncio.create_task(gate.run(release.wait)) for _ in range(2)]
            await asyncio.sleep(0.05)
            with self.assertRaises(ApiError) as ctx:
                await gate.run(lambda: None)
            self.assertEqual(ctx.exception.code, "busy")
            release.set()
            await asyncio.gather(*running)
            self.assertEqual(gate.pending, 0)

        asyncio.run(scenario())

    def test_runs_one_at_a_time(self):
        async def scenario():
            gate = InferenceGate(max_waiting=4)
            active, peak = 0, 0
            lock = threading.Lock()

            def work():
                nonlocal active, peak
                with lock:
                    active += 1
                    peak = max(peak, active)
                threading.Event().wait(0.02)
                with lock:
                    active -= 1

            await asyncio.gather(*(gate.run(work) for _ in range(4)))
            self.assertEqual(peak, 1)

        asyncio.run(scenario())


class GridTest(unittest.TestCase):
    def test_cells(self):
        self.assertEqual(grid_cell(0, 0, 300, 300), {"row": 0, "col": 0})
        self.assertEqual(grid_cell(150, 150, 300, 300), {"row": 1, "col": 1})
        self.assertEqual(grid_cell(300, 300, 300, 300), {"row": 2, "col": 2})
        self.assertEqual(grid_cell(299, 10, 300, 300), {"row": 0, "col": 2})


if __name__ == "__main__":
    unittest.main()


class PatchedOpenerTest(ClientMixin, unittest.TestCase):
    """Ultralytics replaces PIL.Image.open with a wrapper that, on an unidentified
    file, calls check_requirements("pi-heif") (a pip auto-install attempt). Uploads
    must be decoded with Pillow's own opener so junk never reaches that wrapper."""

    def test_upload_decoding_ignores_replaced_image_open(self):
        calls = []

        def replaced_open(*args, **kwargs):
            calls.append(args)
            raise ModuleNotFoundError("No module named 'pi_heif'")

        client = self.make_client()
        with unittest.mock.patch.object(Image, "open", replaced_open):
            bad = self.post(client, b"not an image at all" * 10)
            good = self.post(client, image_bytes((200, 100), orientation=6))
        self.assertEqual(bad.status_code, 415, bad.text)
        self.assertEqual(bad.json()["error"]["code"], "invalid_image")
        self.assertEqual(good.status_code, 200, good.text)
        self.assertEqual(good.json()["image"]["width"], 100)
        self.assertEqual(calls, [])

    def test_unexpected_error_returns_json_without_details(self):
        client = self.make_client()
        self.stub.detect = lambda img: (_ for _ in ()).throw(RuntimeError("secret path /x"))
        r = self.post(client, image_bytes())
        self.assertEqual(r.status_code, 500)
        self.assertEqual(r.json()["error"]["code"], "server_error")
        self.assertNotIn("secret", r.text)


class NoDiskSpillTest(ClientMixin, unittest.TestCase):
    """The detect endpoint reads the raw body in memory and never runs Starlette's
    multipart parser, which spools parts above 1 MiB to a temporary file.

    Scope: these tests check the current endpoint only. They do not by themselves
    prove the earlier multipart endpoint spilled to disk (that was seen once while
    the helper still posted multipart; the helper now posts a raw body)."""

    def test_large_upload_never_rolls_over_to_disk(self):
        import random
        import tempfile as tf

        rnd = random.Random(1)
        img = Image.frombytes("RGB", (900, 900), bytes(rnd.getrandbits(8) for _ in range(900 * 900 * 3)))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        data = buf.getvalue()
        self.assertGreater(len(data), 1024 * 1024)
        rollovers = []
        original = tf.SpooledTemporaryFile.rollover

        def spy(self_):
            rollovers.append(1)
            return original(self_)

        client = self.make_client()
        with unittest.mock.patch.object(tf.SpooledTemporaryFile, "rollover", spy):
            r = self.post(client, data, ctype="image/png")
        self.assertEqual(r.status_code, 200, r.text[:200])
        self.assertEqual(rollovers, [])


class FormatPreflightTest(ClientMixin, unittest.TestCase):
    """WebP's decoder allocates its canvas while opening, before the app's pixel
    limits can be checked, so only JPEG and PNG are accepted, and the format is
    decided from the leading bytes before any Pillow decoder is created."""

    def test_webp_is_rejected_before_its_decoder_opens(self):
        from PIL import WebPImagePlugin

        opened = []
        original = WebPImagePlugin.WebPImageFile._open

        def spy(self_):
            opened.append(1)
            return original(self_)

        client = self.make_client()
        with unittest.mock.patch.object(WebPImagePlugin.WebPImageFile, "_open", spy):
            r = self.post(client, image_bytes(fmt="WEBP"), ctype="image/webp")
        self.assertEqual(r.status_code, 415, r.text)
        self.assertEqual(r.json()["error"]["code"], "unsupported_format")
        self.assertEqual(opened, [])
        self.assertEqual(self.stub.seen_sizes, [])

    def test_png_bytes_sent_as_jpeg_type_still_decode_as_png(self):
        r = self.post(self.make_client(), image_bytes(fmt="PNG"), ctype="image/jpeg")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["image"]["format"], "PNG")

    def test_animated_png_uses_first_frame(self):
        frames = [Image.new("RGB", (120, 80), c) for c in ("red", "blue", "green")]
        buf = io.BytesIO()
        frames[0].save(buf, format="PNG", save_all=True, append_images=frames[1:], duration=100)
        client = self.make_client()
        body = self.post(client, buf.getvalue(), ctype="image/png").json()
        self.assertEqual((body["image"]["width"], body["image"]["height"]), (120, 80))
        preview = Image.open(io.BytesIO(base64.b64decode(body["preview"]["data_url"].split(",", 1)[1])))
        r, g, b = preview.convert("RGB").getpixel((60, 40))
        self.assertGreater(r, 200)  # first frame (red), not a later one
        self.assertLess(b, 60)


class MultipartBodyTest(ClientMixin, unittest.TestCase):
    def test_multipart_upload_is_not_parsed_or_spooled(self):
        import tempfile as tf

        big = Image.new("RGB", (900, 900), "white")
        buf = io.BytesIO()
        big.save(buf, format="PNG", compress_level=0)
        rollovers = []
        original = tf.SpooledTemporaryFile.rollover

        def spy(self_):
            rollovers.append(1)
            return original(self_)

        client = self.make_client()
        with unittest.mock.patch.object(tf.SpooledTemporaryFile, "rollover", spy):
            r = client.post("/api/detect", files={"image": ("a.png", buf.getvalue(), "image/png")})
        self.assertEqual(r.status_code, 415)
        self.assertEqual(rollovers, [])
        self.assertEqual(self.stub.seen_sizes, [])


class DeployInfoTest(ClientMixin, unittest.TestCase):
    def test_commit_from_environment_when_no_git(self):
        with unittest.mock.patch.dict(os.environ, {"FINDIT_COMMIT": "abc1234"}):
            client = self.make_client()
        self.assertEqual(client.get("/api/info").json()["source"]["commit"], "abc1234")

    def test_static_files_are_revalidated(self):
        # index.html, app.js and i18n.js must change together after an update; a
        # heuristically cached old app.js next to a new index.html breaks the page.
        client = self.make_client()
        for path in ("/", "/static/app.js", "/static/i18n.js"):
            r = client.get(path)
            self.assertEqual(r.status_code, 200, path)
            self.assertEqual(r.headers.get("cache-control"), "no-cache", path)
