# FindIt server image. Build context: the repository root (see .dockerignore, an allowlist:
# only the app, its static files, the pinned requirements and the license files enter it).
# The YOLOv8s weights are NOT in the image or in git: compose.yaml mounts them read-only and
# FINDIT_MODEL points at the file. Without them /api/health reports model_loaded=false, the
# container is unhealthy and /api/detect answers 503; no download is ever attempted.
# Base tag and digest are pinned (same base as the other apps on the server); update together.
FROM python:3.13.16-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# OpenCV (pulled in by Ultralytics) needs libGL and GLib at import time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /srv/findit

COPY deploy/requirements-server.txt .
RUN pip install --no-deps -r requirements-server.txt && pip check

COPY findit ./findit
COPY LICENSE NOTICE.md README.md ./
# Defence in depth: local browser-test images must never ship, even if .dockerignore changes.
RUN test ! -e findit/web/_samples

# Unprivileged user; nothing is written at runtime except the in-memory /tmp (compose
# runs the container with a read-only root filesystem).
RUN useradd --system --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /run/findit-model
USER 10001:10001

# Shown on the Source page (AGPL §13): the exact commit this image was built from.
ARG FINDIT_COMMIT
ENV FINDIT_COMMIT=${FINDIT_COMMIT} \
    FINDIT_MODEL=/run/findit-model/yolov8s.pt \
    YOLO_CONFIG_DIR=/tmp/Ultralytics \
    MPLCONFIGDIR=/tmp/matplotlib \
    OMP_NUM_THREADS=2

EXPOSE 8000
# Healthy only when the model is loaded, not merely when the process is up.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD ["python", "-c", "import json, sys, urllib.request; r = urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=2); sys.exit(0 if r.status == 200 and json.load(r).get('model_loaded') is True else 1)"]

# 0.0.0.0 inside the container only; compose publishes the port on 127.0.0.1 for Nginx.
# One worker: the model is loaded once; the app runs one inference at a time.
# No access log: the app must not log client addresses or request details.
CMD ["uvicorn", "findit.app:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header", "--no-access-log", "--workers", "1"]
