"""Detector accepts only an existing local weights file; nothing is downloaded.

Ultralytics is replaced by a stub, so these tests run no import, download or inference.
"""

import builtins
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from findit.detector import Detector


class StubYOLO:
    calls: list = []

    def __init__(self, path):
        StubYOLO.calls.append((path, os.environ.get("YOLO_OFFLINE")))


class ModelLoadingTest(unittest.TestCase):
    def setUp(self):
        StubYOLO.calls = []
        self.imports = []
        real_import = builtins.__import__

        def tracking_import(name, *args, **kwargs):
            if name.split(".")[0] == "ultralytics":
                self.imports.append(name)
            return real_import(name, *args, **kwargs)

        stub_module = types.ModuleType("ultralytics")
        stub_module.YOLO = StubYOLO
        for patcher in (
            mock.patch.dict(sys.modules, {"ultralytics": stub_module}),
            mock.patch.object(builtins, "__import__", tracking_import),
            mock.patch.dict(os.environ, {"YOLO_OFFLINE": "0"}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)

    def assert_rejected(self, model_path):
        with self.assertRaises((FileNotFoundError, ValueError)):
            Detector(model_path)
        self.assertEqual(self.imports, [])
        self.assertEqual(StubYOLO.calls, [])

    def test_missing_file_is_rejected_before_import(self):
        self.assert_rejected(self.tmp / "yolov8n.pt")

    def test_bare_asset_name_is_rejected(self):
        # Ultralytics would resolve "yolov8n.pt" to a GitHub release download.
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(self.tmp)
        self.assert_rejected("yolov8n.pt")

    def test_url_is_rejected(self):
        self.assert_rejected("https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt")

    def test_directory_is_rejected(self):
        self.assert_rejected(self.tmp)

    def test_existing_local_file_is_passed_to_loader_offline(self):
        weights = self.tmp / "local.pt"
        weights.write_bytes(b"not a real model")
        Detector(weights)
        self.assertEqual(StubYOLO.calls, [(str(weights.resolve()), "1")])


if __name__ == "__main__":
    unittest.main()
