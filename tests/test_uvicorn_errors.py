"""Unexpected errors through a real Uvicorn server: safe JSON, headers, clean log.

Starts `uvicorn --factory fault_app:create` in a subprocess and checks the actual
HTTP response and the server's stdout/stderr. No model, download or network
beyond 127.0.0.1.
"""

import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class UvicornErrorTest(unittest.TestCase):
    def test_500_hides_details_keeps_headers_and_log_is_clean(self):
        marker = "SECRET-" + uuid.uuid4().hex
        port = free_port()
        log = tempfile.TemporaryFile()
        env = dict(os.environ, FINDIT_TEST_MARKER=marker)
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "fault_app:create", "--factory", "--app-dir", str(ROOT / "tests"),
             "--host", "127.0.0.1", "--port", str(port), "--no-access-log"],
            cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            base = f"http://127.0.0.1:{port}"
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + "/api/health", timeout=1).read()
                    break
                except OSError:
                    time.sleep(0.1)
            buf = io.BytesIO()
            Image.new("RGB", (64, 64), "white").save(buf, format="JPEG")
            responses = []
            for _ in range(2):  # the second request shows the inference gate was released
                req = urllib.request.Request(base + "/api/detect", data=buf.getvalue(),
                                             headers={"Content-Type": "image/jpeg"}, method="POST")
                with self.assertRaises(urllib.error.HTTPError) as ctx:
                    urllib.request.urlopen(req, timeout=10)
                responses.append((ctx.exception.code, dict(ctx.exception.headers), ctx.exception.read().decode()))
        finally:
            proc.terminate()
            proc.wait(timeout=10)
        log.seek(0)
        server_log = log.read().decode(errors="replace")

        for status, headers, body in responses:
            self.assertEqual(status, 500)
            self.assertEqual(json.loads(body)["error"]["code"], "server_error")
            self.assertNotIn(marker, body)
            self.assertIn("default-src 'self'", headers.get("content-security-policy", ""))
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")
            self.assertEqual(headers.get("cache-control"), "no-store")
        self.assertNotIn(marker, server_log)
        self.assertNotIn("/private/user/photo.jpg", server_log)
        self.assertNotIn("Traceback", server_log)
        self.assertIn("server_error", server_log)


if __name__ == "__main__":
    unittest.main()
