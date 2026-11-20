# Deploying FindIt behind the existing Nginx

> Not deployed yet. These files were prepared on 2026-10-29 and have **not** been run:
> no image was built, `nginx -t` was not run, and nothing was measured on the server.
> Commands below are for the owner to run on the server.

Target: the existing x86_64 Docker + Compose server with Nginx 1.24 and Let’s Encrypt
(certbot webroot), where other apps already run. This adds one Compose project, one site
file, one snippet and one certificate; it does not change other sites or their containers.

| Item | FindIt | Must not clash with |
| --- | --- | --- |
| Compose project / container | `findit` / `findit` | other projects on the server |
| Host port (loopback only) | `127.0.0.1:18780` (`FINDIT_PORT`) | check with `ss -ltnp` |
| Nginx | `conf.d/findit.conf`, `snippets/findit-proxy.conf` | existing site files |
| ACME webroot / logs | `/var/www/findit-acme`; error log `/var/log/nginx/findit.error.log` (no access log) | other sites’ |
| Weights (outside the repo) | `/opt/findit-model/yolov8s.pt`, mounted read-only | — |

Limits in `compose.yaml`: `mem_limit 1536m`, `cpus 2`, `pids_limit 256`, read-only root
filesystem, all capabilities dropped, 32 MiB in-memory `/tmp`, logs 10 MB × 3. Peak RSS was
~700 MiB on the Mac during the feasibility run (YOLOv8s, CPU); the server value is unknown.

## 0. Read-only checks first

```bash
nproc; free -h; df -h /; uptime
docker version --format '{{.Server.Version}}'; docker compose version
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}'
ss -ltnp | grep -E ':18780\b' || echo "18780 free"
nginx -v; ls /etc/nginx/conf.d/
dig +short <your-findit-domain>
```

## 1. Source and weights

1. The public GitHub repository must exist first (AGPL §13: the Source link on the site
   must lead to the code of the running commit). Push `main` there, then on the server:

   ```bash
   sudo git clone <public-repo-url> /opt/findit
   cd /opt/findit && git checkout <commit>   # the reviewed commit
   ```

2. Put the weights outside the repository and check the hash against `models/MODELS.md`:

   ```bash
   sudo install -d -m 755 /opt/findit-model
   sudo curl -L -o /opt/findit-model/yolov8s.pt \
     https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.pt
   sha256sum /opt/findit-model/yolov8s.pt   # 1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a
   sudo chmod 644 /opt/findit-model/yolov8s.pt
   ```

## 2. Build and start

```bash
cd /opt/findit
# .env is git-ignored; later `docker compose` commands read it too
cat > .env <<ENV
FINDIT_MODEL_DIR_HOST=/opt/findit-model
FINDIT_SOURCE_URL=<public-repo-url>
FINDIT_COMMIT=$(git rev-parse --short HEAD)
ENV
docker compose up -d --build --wait
curl -s http://127.0.0.1:18780/api/health      # {"status":"ok","model_loaded":true}
curl -s http://127.0.0.1:18780/api/info        # model sha256 = value above; source.url and commit set
docker exec findit sh -c 'test ! -e /srv/findit/findit/web/_samples && echo "no samples in image"'
```

The container is healthy only when the model is loaded. Compose refuses to start without
`FINDIT_MODEL_DIR_HOST`, `FINDIT_SOURCE_URL` and `FINDIT_COMMIT`.

## 3. Nginx and certificate

Replace `findit.example.com` in both site files with the real domain first.

```bash
sudo install -d -m 755 /var/www/findit-acme
sudo install -m 644 deploy/nginx/findit-proxy.conf /etc/nginx/snippets/findit-proxy.conf
sudo install -m 644 deploy/nginx/findit.bootstrap.conf.example /etc/nginx/conf.d/findit.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/findit-acme -d <domain> --deploy-hook "systemctl reload nginx"
sudo install -m 644 deploy/nginx/findit.conf.example /etc/nginx/conf.d/findit.conf
sudo nginx -t && sudo systemctl reload nginx
```

If no other site listens on IPv6 port 443, remove `listen [::]:443 ssl;` (as was done for
Food Lens). `deploy/nginx/check-config.sh` runs `nginx -t` against both files locally with
Docker and a throwaway certificate.

Logging: every server block (HTTP, HTTPS and the bootstrap file) has `access_log off`, so
Nginx does not record each request. The error log (`/var/log/nginx/findit.error.log`,
level `warn`) is kept for diagnostics; when an error occurs Nginx may write client
metadata such as the IP address, request line and host there. Nginx is not configured to
log request bodies, and the proxy does not buffer request or response bodies to disk.

## Live camera mode on the server

`POST /api/detect/live` runs YOLOv8s on the server CPU for every accepted frame. The app
runs one inference at a time and gives queued uploads priority over new live frames.
An upload can wait behind the live frame already running. The app refuses new live frames
when live work reaches `FINDIT_LIVE_DUTY` (default 0.6) of the last 2 s. Admitted frames
run to completion and count toward the budget even if their request is cancelled.

On a development Mac with one Uvicorn worker and `OMP_NUM_THREADS=2`, four clients sent
512 × 288 JPEGs at `imgsz=512` without pacing for 12 s. The app accepted 126 requests and
refused 27,101 with `503 busy` in a median of 1.4 ms. All three concurrent uploads returned
`200` in 123–138 ms, compared with 76–95 ms at idle. These measurements cover local Uvicorn.
To reduce live load, lower `FINDIT_LIVE_DUTY` in `.env` or set `FINDIT_LIVE=0`, then run
`docker compose up -d`.

The cap is global, not per client. A per-IP limit in Nginx (`limit_req_zone` in `conf.d`
plus `limit_req` on `location = /api/detect/live`) would stop one client from using all of it;
the browser treats `429` like `busy`. That Nginx change is **not included and not tested** here
(Docker was not running when this was written, so `check-config.sh` could not be run).

## 4. Smoke and rollback

- `https://<domain>/`: upload a JPEG, search, select, export; Source page shows the repo
  URL and commit. The camera needs HTTPS, so this is the first place it can work on a phone
  (check Live camera there too: `Live Active`, FPS/latency, voice on a phone browser).
- Rollback: `git checkout <previous commit>`, update `FINDIT_COMMIT` in `.env`,
  `docker compose up -d --build --wait`. Removing FindIt: `docker compose down`, remove
  `conf.d/findit.conf` and the snippet, reload Nginx.
