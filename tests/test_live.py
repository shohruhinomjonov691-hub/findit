"""Live endpoint (POST /api/detect/live): limits, busy handling, duty-cycle cap. Stub detector only."""

import asyncio
import io
import os
import threading
import time
import unittest
import unittest.mock

import httpx
from PIL import Image

from findit.app import ApiError, InferenceGate, LiveBudget, Settings
from findit.detector import Detection
from tests.test_app import ClientMixin, image_bytes


class LiveStub:
    """Records the per-call overrides; can block or sleep inside detect()."""

    def __init__(self, model_path, detections=None):
        self.model_path = model_path
        self.class_names = {0: "person", 41: "cup", 73: "book"}
        self.detections = detections or []
        self.calls = []
        self.started = threading.Event()
        self.release = None  # set to a threading.Event to block detect()
        self.sleep = 0.0

    def detect(self, img, imgsz=None, conf=None, max_det=None):
        self.calls.append({"size": img.size, "imgsz": imgsz, "conf": conf, "max_det": max_det})
        self.started.set()
        if self.release is not None:
            self.release.wait(5)
        if self.sleep:
            time.sleep(self.sleep)
        return list(self.detections), {"wall_ms": 7.5}


class LiveMixin(ClientMixin):
    def make_client(self, detections=None, settings=None, fail=False):
        client = super().make_client(detections, settings, fail)
        stub = LiveStub(self.stub.model_path, detections)
        self.stub = stub
        client.app.state.detector = None if fail else stub
        return client

    def live(self, client, data, imgsz=None, ctype="image/jpeg"):
        url = "/api/detect/live" + (f"?imgsz={imgsz}" if imgsz is not None else "")
        return client.post(url, content=data, headers={"Content-Type": ctype})


def small_jpeg(size=(320, 240)):
    buf = io.BytesIO()
    Image.new("RGB", size, "gray").save(buf, format="JPEG", quality=60)
    return buf.getvalue()


class LiveEndpointTest(LiveMixin, unittest.TestCase):
    def test_returns_detections_without_preview(self):
        cup = Detection(41, "cup", 0.9, [200.0, 100.0, 300.0, 200.0])
        client = self.make_client([cup])
        r = self.live(client, small_jpeg((320, 240)), imgsz=416)
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertNotIn("preview", body)
        self.assertEqual(body["image"], {"width": 320, "height": 240})
        self.assertEqual(body["imgsz"], 416)
        d = body["detections"][0]
        self.assertEqual((d["class_name"], d["score"], d["cell"]), ("cup", 0.9, {"row": 1, "col": 2}))
        self.assertEqual(self.stub.calls, [{"size": (320, 240), "imgsz": 416, "conf": 0.35, "max_det": 20}])
        self.assertEqual(r.headers["cache-control"], "no-store")

    def test_512_is_accepted_for_the_accurate_profile(self):
        client = self.make_client()
        r = self.live(client, small_jpeg((512, 384)), imgsz=512)
        self.assertEqual((r.status_code, r.json()["imgsz"]), (200, 512))
        self.assertEqual(self.stub.calls[-1]["imgsz"], 512)

    def test_default_imgsz_is_smallest_option(self):
        client = self.make_client()
        self.assertEqual(self.live(client, small_jpeg()).json()["imgsz"], 320)

    def test_rejects_unlisted_imgsz(self):
        client = self.make_client()
        for bad in (640, 100, 0):
            r = self.live(client, small_jpeg(), imgsz=bad)
            self.assertEqual((r.status_code, r.json()["error"]["code"]), (400, "bad_parameter"), bad)
        self.assertEqual(self.stub.calls, [])

    def test_only_jpeg_is_accepted(self):
        client = self.make_client()
        r = self.live(client, image_bytes((200, 100), fmt="PNG"), ctype="image/png")
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (415, "unsupported_format"))
        self.assertEqual(self.stub.calls, [])

    def test_frame_size_limits(self):
        client = self.make_client()
        r = self.live(client, b"\xff" * (512 * 1024 + 1))
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (413, "file_too_large"))
        self.assertIn("512 KiB", r.json()["error"]["message"])  # not "0 MiB"
        big = self.live(client, small_jpeg((1200, 900)))  # 1.08 MP > 1 MP live pixel cap
        self.assertEqual((big.status_code, big.json()["error"]["code"]), (413, "image_dimensions"))
        self.assertEqual(self.stub.calls, [])

    def test_garbage_and_empty_bodies(self):
        client = self.make_client()
        self.assertEqual(self.live(client, b"not an image" * 20).json()["error"]["code"], "invalid_image")
        self.assertEqual(self.live(client, b"").json()["error"]["code"], "empty_file")

    def test_disabled_by_setting(self):
        client = self.make_client(settings=Settings(live_enabled=False))
        r = self.live(client, small_jpeg())
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (404, "live_disabled"))
        self.assertFalse(client.get("/api/info").json()["live"]["enabled"])

    def test_model_unavailable(self):
        client = self.make_client(fail=True)
        self.assertEqual(self.live(client, small_jpeg()).json()["error"]["code"], "model_unavailable")

    def test_info_lists_live_options(self):
        live = self.make_client().get("/api/info").json()["live"]
        self.assertEqual((live["enabled"], live["imgsz"], live["conf_threshold"]), (True, [320, 416, 512], 0.35))


class LiveBusyTest(LiveMixin, unittest.TestCase):
    def test_live_frame_is_dropped_while_an_upload_is_running(self):
        client = self.make_client()
        self.stub.release = threading.Event()
        result = {}
        t = threading.Thread(target=lambda: result.update(r=client.post(
            "/api/detect", content=image_bytes(), headers={"Content-Type": "image/jpeg"})))
        t.start()
        self.assertTrue(self.stub.started.wait(5))
        started = time.perf_counter()
        r = self.live(client, small_jpeg())
        waited = time.perf_counter() - started
        self.stub.release.set()
        t.join(5)
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (503, "busy"))
        self.assertLess(waited, 1.0, "a live frame must be refused at once, not queued")
        self.assertGreaterEqual(int(r.headers["retry-after"]), 1)
        self.assertGreater(r.json()["error"]["retry_ms"], 0)
        self.assertEqual(result["r"].status_code, 200)  # the upload itself was not disturbed
        self.assertEqual(len(self.stub.calls), 1)  # only the upload reached the model

    def test_duty_cycle_cap_refuses_frames_after_a_burst(self):
        # 0.25 s of inference per frame; allowed: 10% of a 2 s window = 0.2 s.
        client = self.make_client(settings=Settings(live_max_duty=0.1, live_duty_window_s=2.0))
        self.stub.sleep = 0.25
        first = self.live(client, small_jpeg())
        second = self.live(client, small_jpeg())
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 503, second.text)
        err = second.json()["error"]
        self.assertEqual(err["code"], "busy")
        self.assertGreaterEqual(err["retry_ms"], 100)
        self.assertEqual(len(self.stub.calls), 1)
        # Uploads are not subject to the live cap.
        up = client.post("/api/detect", content=image_bytes(), headers={"Content-Type": "image/jpeg"})
        self.assertEqual(up.status_code, 200)

    def test_live_budget_is_checked_again_after_waiting_for_the_frame_body(self):
        app = self.make_client(settings=Settings(live_max_duty=0.05)).app
        self.stub.sleep = 0.15
        frame = small_jpeg((512, 384))

        async def scenario():
            reading, release = asyncio.Event(), asyncio.Event()

            async def slow_body():
                reading.set()
                await release.wait()
                yield frame

            path = "/api/detect/live?imgsz=512"
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                delayed = asyncio.create_task(client.post(path, content=slow_body()))
                try:
                    await asyncio.wait_for(reading.wait(), 2)
                    first = await client.post(path, content=frame)
                    self.assertEqual(first.status_code, 200, first.text)
                finally:
                    release.set()
                    second = await delayed
                self.assertEqual((second.status_code, second.json()["error"]["code"]), (503, "busy"))
                self.assertEqual(len(self.stub.calls), 1)

        asyncio.run(scenario())

    def test_cancelled_live_frame_still_counts_against_the_budget(self):
        app = self.make_client(settings=Settings(live_max_duty=0.05)).app
        self.stub.release = threading.Event()
        self.stub.sleep = 0.15
        frame = small_jpeg((512, 384))

        async def scenario():
            path = "/api/detect/live?imgsz=512"
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                first = asyncio.create_task(client.post(path, content=frame))
                try:
                    self.assertTrue(await asyncio.to_thread(self.stub.started.wait, 2))
                    first.cancel()
                finally:
                    self.stub.release.set()
                with self.assertRaises(asyncio.CancelledError):
                    await first
                second = await client.post(path, content=frame)
                self.assertEqual((second.status_code, second.json()["error"]["code"]), (503, "busy"))
                self.assertEqual(len(self.stub.calls), 1)

        asyncio.run(scenario())


class LiveEnvSettingsTest(LiveMixin, unittest.TestCase):
    """FINDIT_LIVE and FINDIT_LIVE_DUTY: a wrong value must never stop the app from starting
    (it runs with restart: unless-stopped) nor silently weaken or disable the protection."""

    def settings(self, **env):
        base = {k: v for k, v in os.environ.items() if k not in ("FINDIT_LIVE", "FINDIT_LIVE_DUTY")}
        with unittest.mock.patch.dict(os.environ, {**base, **env}, clear=True):
            return Settings()

    def test_live_switch_accepts_the_usual_spellings(self):
        for off in ("0", "false", "FALSE", " off ", "No", "nO"):
            self.assertFalse(self.settings(FINDIT_LIVE=off).live_enabled, off)
        for on in ("1", "true", "On", "yes", " YES "):
            self.assertTrue(self.settings(FINDIT_LIVE=on).live_enabled, on)
        self.assertTrue(self.settings().live_enabled, "unset: on")
        self.assertTrue(self.settings(FINDIT_LIVE="").live_enabled, "empty: on")

    def test_unrecognised_live_switch_keeps_the_default_and_warns(self):
        with self.assertLogs("findit", "WARNING") as logs:
            self.assertTrue(self.settings(FINDIT_LIVE="maybe").live_enabled)
        self.assertIn("FINDIT_LIVE", "\n".join(logs.output))

    def test_valid_duty_values(self):
        for text, want in (("0.3", 0.3), ("1", 1.0), (" 0.05 ", 0.05), ("1.0", 1.0)):
            self.assertEqual(self.settings(FINDIT_LIVE_DUTY=text).live_max_duty, want, text)
        self.assertEqual(self.settings().live_max_duty, 0.6)
        self.assertEqual(self.settings(FINDIT_LIVE_DUTY="").live_max_duty, 0.6)

    def test_invalid_or_out_of_range_duty_falls_back_to_the_default_with_a_warning(self):
        for bad in ("abc", "0,5", "nan", "inf", "-inf", "0", "-1", "1.5", "5", "1e9", "0x1"):
            with self.subTest(value=bad), self.assertLogs("findit", "WARNING") as logs:
                self.assertEqual(self.settings(FINDIT_LIVE_DUTY=bad).live_max_duty, 0.6)
            self.assertIn("FINDIT_LIVE_DUTY", "\n".join(logs.output))

    def test_the_app_starts_and_still_protects_with_a_bad_duty(self):
        for bad in ("abc", "0", "5"):
            with self.subTest(value=bad), self.assertLogs("findit", "WARNING"):
                with unittest.mock.patch.dict(os.environ, {"FINDIT_LIVE_DUTY": bad}):
                    client = self.make_client()
            self.assertEqual(client.app.state.live_budget.max_duty, 0.6)
            self.assertEqual(self.live(client, small_jpeg()).status_code, 200, "0 must not refuse every frame")
            self.assertEqual(client.get("/api/info").json()["live"]["max_duty"], 0.6)

    def test_switched_off_by_env_spelling(self):
        with unittest.mock.patch.dict(os.environ, {"FINDIT_LIVE": "off"}):
            client = self.make_client()
        r = self.live(client, small_jpeg())
        self.assertEqual((r.status_code, r.json()["error"]["code"]), (404, "live_disabled"))
        self.assertFalse(client.get("/api/info").json()["live"]["enabled"])


class LiveBudgetTest(unittest.TestCase):
    def test_burst_then_recovery(self):
        now = [100.0]
        b = LiveBudget(max_duty=0.5, window_s=2.0, clock=lambda: now[0])
        self.assertEqual(b.retry_after_ms(), 0)
        for _ in range(4):  # 4 x 0.25 s = 1.0 s of a 2.0 s window = exactly the cap
            now[0] += 0.3
            b.record(0.25)
        wait = b.retry_after_ms()
        self.assertGreater(wait, 0)
        now[0] += wait / 1000 + 0.01
        self.assertEqual(b.retry_after_ms(), 0, "allowed again after the advised wait")
        now[0] += 5
        self.assertEqual(b.retry_after_ms(), 0)
        self.assertEqual(sum(d for _, d in b.spans), 0)  # old spans are dropped

    def test_light_use_is_never_throttled(self):
        now = [0.0]
        b = LiveBudget(max_duty=0.6, window_s=2.0, clock=lambda: now[0])
        for _ in range(50):  # one 0.2 s frame per second = 20% duty
            now[0] += 1.0
            self.assertEqual(b.retry_after_ms(), 0)
            b.record(0.2)


class GateCancellationTest(unittest.TestCase):
    def test_cancelled_request_does_not_free_the_slot_while_inference_still_runs(self):
        """A browser that aborts a frame must not let a second inference overlap the first:
        the model is not thread-safe."""

        async def scenario():
            gate = InferenceGate(max_waiting=2)
            release, running, overlap = threading.Event(), threading.Event(), []
            active = []

            def slow():
                active.append(1)
                running.set()
                release.wait(5)
                active.pop()

            def second():
                overlap.append(len(active))

            first = asyncio.create_task(gate.run(slow))
            await asyncio.get_running_loop().run_in_executor(None, running.wait, 5)
            nxt = asyncio.create_task(gate.run(second))
            first.cancel()  # the client went away
            await asyncio.sleep(0.1)
            self.assertEqual(overlap, [], "second inference started while the first thread still ran")
            release.set()
            await asyncio.gather(first, return_exceptions=True)
            await nxt
            self.assertEqual(overlap, [0])
            self.assertEqual(gate.pending, 0)

        asyncio.run(scenario())

    def test_try_run_refuses_instead_of_waiting(self):
        async def scenario():
            gate = InferenceGate(max_waiting=2)
            release = threading.Event()
            first = asyncio.create_task(gate.run(release.wait))
            await asyncio.sleep(0.05)
            with self.assertRaises(ApiError) as ctx:
                await gate.try_run(lambda: None)
            self.assertEqual((ctx.exception.status, ctx.exception.code), (503, "busy"))
            release.set()
            await first
            self.assertIsNone(await gate.try_run(lambda: None))

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
