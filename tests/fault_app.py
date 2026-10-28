"""Uvicorn factory for tests/test_uvicorn_errors.py: a stub detector that raises.

The exception message carries a synthetic secret marker (FINDIT_TEST_MARKER) that
must never reach the HTTP response or the server log.
"""

import os
import tempfile
from pathlib import Path

from findit.app import Settings, create_app


class FaultyDetector:
    class_names = {0: "person"}

    def __init__(self, model_path):
        self.model_path = model_path

    def detect(self, img):
        raise RuntimeError(f"{os.environ['FINDIT_TEST_MARKER']} /private/user/photo.jpg")


def create():
    weights = Path(tempfile.mkdtemp()) / "stub.pt"
    weights.write_bytes(b"stub")
    return create_app(Settings(model_path=weights), lambda s: FaultyDetector(s.model_path))
