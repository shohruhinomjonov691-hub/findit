# Model weights

Weights are not committed. Download from the official Ultralytics release and verify:

| File | Source | Size (bytes) | SHA-256 |
| --- | --- | --- | --- |
| `yolov8n.pt` | https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt | 6549796 | `f59b3d833e2ff32e194b5bb8e08d211dc7c5bdf144b90d2c8412c47ccfc83b36` |
| `yolov8s.pt` | https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.pt | 22588772 | `1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a` |

The SHA-256 values match the `digest` field the GitHub Releases API reports for
release `v8.4.0` of `ultralytics/assets` (checked 2026-10-27).

```bash
curl -L -o models/yolov8n.pt https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt
shasum -a 256 models/yolov8n.pt
```

Both are COCO-pretrained (80 classes) detection models, used as-is: no training or
fine-tuning. License: AGPL-3.0 (Ultralytics), see [../NOTICE.md](../NOTICE.md).
