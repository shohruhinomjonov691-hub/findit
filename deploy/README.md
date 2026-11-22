# FindIt on the server — update runbook

FindIt runs in Docker (Compose project `findit`, container `findit`) behind the existing
Nginx at **https://findit.gotrips.cloud**, on a server where other apps also run. This file
is for updating it. The first-install steps are kept at the end for reference.

What has and has not been checked: the owner reports FindIt running on the server. The
per-client `limit_req` rules (`findit-limits.conf`, `findit-proxy.conf`) were added on
2026-11-22 **without** `nginx -t` or a load test on the development machine (the Docker
daemon was not running there); run `nginx -t` on the server before reloading, as below.

| Item | FindIt | Must not clash with |
| --- | --- | --- |
| Compose project / container | `findit` / `findit` | other projects on the server |
| Host port (loopback only) | `127.0.0.1:18780` (`FINDIT_PORT`) | check with `ss -ltnp` |
| Nginx files | `conf.d/findit.conf` (site), `conf.d/findit-limits.conf` (limits), `snippets/findit-proxy.conf` | existing site files |
| ACME webroot / logs | `/var/www/findit-acme`; error log `/var/log/nginx/findit.error.log` (no access log) | other sites’ |
| Weights (outside the repo) | `/opt/findit-model/yolov8s.pt`, mounted read-only | — |
| Branch to deploy | `main` (`develop` is kept identical to it) | — |

Limits in `compose.yaml`: `mem_limit 1536m`, `cpus 2`, `pids_limit 256`, read-only root
filesystem, all capabilities dropped, 32 MiB in-memory `/tmp`, logs 10 MB × 3,
`FINDIT_LIVE_DUTY` 0.35. Peak RSS was ~700 MiB on a development Mac (YOLOv8s, CPU); no
server figure has been measured.

## Update (run on the server)

The repository folder is `/opt/findit` if the first install followed this file; confirm it:

```bash
docker inspect findit --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}'
```

### 0. Note the current state (this is the rollback point)

```bash
cd /opt/findit
git status --short                              # should print nothing; do not update over local edits
git rev-parse --short HEAD                      # commit the checkout is on
docker inspect findit --format '{{.Config.Image}}  {{.State.Health.Status}}'   # findit:<commit>  healthy
curl -s http://127.0.0.1:18780/api/info | grep -o '"commit":"[^"]*"'            # commit the running container reports
grep -E '^FINDIT_' .env | sed 's/=.*/=…/'      # which variables .env sets (values hidden)
```

Write the first commit down as `PREV`. If `git status` prints changed files, stop and look at
them first.

### 1. Get the new code

```bash
git fetch origin
git checkout main                               # needed if the checkout was left on a detached commit
git pull --ff-only origin main
git rev-parse --short HEAD                      # the commit you are about to deploy
git log --oneline PREV..HEAD                    # what changes (replace PREV)
```

### 2. Point `.env` at the new commit

Compose refuses to build without `FINDIT_COMMIT`, and the Source page (AGPL §13) shows it, so
it must be the commit that is checked out:

```bash
sudo sed -i "s/^FINDIT_COMMIT=.*/FINDIT_COMMIT=$(git rev-parse --short HEAD)/" .env
grep -E '^FINDIT_(COMMIT|LIVE_DUTY|LIVE)=' .env
```

`FINDIT_LIVE_DUTY` is optional: without a line in `.env` Compose uses 0.35. A line set
earlier (for example 0.4) wins; delete it to follow the default, or edit it.

### 3. Nginx (only when `deploy/nginx/` changed in this update)

`git diff PREV..HEAD --stat -- deploy/nginx` shows it. The site file `conf.d/findit.conf` holds
the real domain and any local edits, so it is **not** replaced here; only the two
domain-free files are:

```bash
sudo cp /etc/nginx/snippets/findit-proxy.conf /root/findit-proxy.conf.bak
diff /etc/nginx/snippets/findit-proxy.conf deploy/nginx/findit-proxy.conf    # what changes
sudo install -m 644 deploy/nginx/findit-limits.conf /etc/nginx/conf.d/findit-limits.conf
sudo install -m 644 deploy/nginx/findit-proxy.conf /etc/nginx/snippets/findit-proxy.conf
sudo nginx -t && sudo systemctl reload nginx
```

If `nginx -t` fails, nothing was reloaded: restore the snippet from the backup, remove
`conf.d/findit-limits.conf` and run `nginx -t` again.

### 4. Build and restart

```bash
docker compose build
docker compose up -d --wait
docker compose ps
```

`--wait` returns when the container is healthy (the model is loaded). The old container keeps
serving until the new image is built; the restart itself takes the model load time
(first answer slower).

### 5. Smoke test

```bash
curl -s http://127.0.0.1:18780/api/health        # {"status":"ok","model_loaded":true}
curl -s http://127.0.0.1:18780/api/info          # commit = the new one; live.max_duty = 0.35 (or your .env value)
docker logs --tail 30 findit                      # no tracebacks; warnings about FINDIT_LIVE* mean a bad .env value
curl -sI https://findit.gotrips.cloud/ | head -3  # 200 over HTTPS
curl -s https://findit.gotrips.cloud/api/health
```

Per-client limits (needs step 3): thirty quick requests from one address should mostly
succeed at first and then show `429`:

```bash
for i in $(seq 1 30); do curl -s -o /dev/null -w '%{http_code}\n' https://findit.gotrips.cloud/api/health; done | sort | uniq -c
```

In the browser: upload a JPEG, search, select, export; **Source** page shows the repository
URL and the new commit; **Live camera** (HTTPS) shows `Live Active`, FPS and latency, and the
voice works on a phone browser.

### 6. Roll back

```bash
cd /opt/findit
git checkout PREV                                 # the commit written down in step 0
sudo sed -i "s/^FINDIT_COMMIT=.*/FINDIT_COMMIT=$(git rev-parse --short HEAD)/" .env
docker compose up -d --build --wait
curl -s http://127.0.0.1:18780/api/info | grep -o '"commit":"[^"]*"'
```

If Nginx was changed too: `sudo cp /root/findit-proxy.conf.bak /etc/nginx/snippets/findit-proxy.conf`,
`sudo rm /etc/nginx/conf.d/findit-limits.conf`, `sudo nginx -t && sudo systemctl reload nginx`.
Removing FindIt completely: `docker compose down`, remove `conf.d/findit.conf`,
`conf.d/findit-limits.conf` and the snippet, reload Nginx. After a rollback, `git checkout main`
before the next update.

## Live camera mode on the server

`POST /api/detect/live` runs YOLOv8s on the server CPU for every accepted frame. The app
runs one inference at a time and gives queued uploads priority over new live frames.
An upload can wait behind the live frame already running. The app refuses new live frames
when live work reaches `FINDIT_LIVE_DUTY` of the last 2 s: 0.35 with `compose.yaml` (the
application's own default without Compose is 0.6). The cap counts wall time, so on a small
shared CPU a low value leaves room for uploads and the other apps. Admitted frames run to
completion and count toward the budget even if their request is cancelled.

On a development Mac with one Uvicorn worker and `OMP_NUM_THREADS=2` (duty 0.6), four clients
sent 512 × 288 JPEGs at `imgsz=512` without pacing for 12 s. The app accepted 126 requests and
refused 27,101 with `503 busy` in a median of 1.4 ms. All three concurrent uploads returned
`200` in 123–138 ms, compared with 76–95 ms at idle. These measurements cover local Uvicorn
only; none were taken on the server. To reduce live load, lower `FINDIT_LIVE_DUTY` in `.env`
or set `FINDIT_LIVE=0`, then run `docker compose up -d`.

The app's cap is global, not per client. Nginx adds a per client address limit
(`findit-limits.conf` zones, rules in `findit-proxy.conf`):

| Route | Rate | Burst | Over the limit |
| --- | --- | --- | --- |
| `= /api/detect/live` | 8 requests/s | 16 | `429` |
| `/api/` (all other API calls) | 3 requests/s | 10 | `429` |

The Live page treats `429` like `busy` and slows down. Rejections are logged at `notice`, so
the error log (level `warn`) does not record them or the client addresses. The numbers are a
reasoned starting point (Fast mode sends at most ~5 frames/s), not measured on the server;
behind a CDN or proxy every visitor shares one address, see the comment in
`findit-limits.conf`.

## Logging

Every Nginx server block (HTTP, HTTPS and the bootstrap file) has `access_log off`, so Nginx
does not record each request. The error log (`/var/log/nginx/findit.error.log`, level `warn`)
is kept for diagnostics; when an error occurs Nginx may write client metadata such as the IP
address, request line and host there. Nginx is not configured to log request bodies, and the
proxy does not buffer request or response bodies to disk. The app runs with `--no-access-log`.

## First install (reference)

Only for a new server; the running site does not need these steps again.

```bash
# 0. read-only checks
nproc; free -h; df -h /; uptime
docker version --format '{{.Server.Version}}'; docker compose version
ss -ltnp | grep -E ':18780\b' || echo "18780 free"
nginx -v; ls /etc/nginx/conf.d/; dig +short <your-findit-domain>

# 1. source (public repository: AGPL §13) and weights (outside the repository)
sudo git clone <public-repo-url> /opt/findit
cd /opt/findit && git checkout main
sudo install -d -m 755 /opt/findit-model
sudo curl -L -o /opt/findit-model/yolov8s.pt \
  https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8s.pt
sha256sum /opt/findit-model/yolov8s.pt   # 1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a (models/MODELS.md)
sudo chmod 644 /opt/findit-model/yolov8s.pt

# 2. build and start (.env is git-ignored; later `docker compose` commands read it too)
cat > .env <<ENV
FINDIT_MODEL_DIR_HOST=/opt/findit-model
FINDIT_SOURCE_URL=<public-repo-url>
FINDIT_COMMIT=$(git rev-parse --short HEAD)
ENV
docker compose up -d --build --wait
curl -s http://127.0.0.1:18780/api/health
docker exec findit sh -c 'test ! -e /srv/findit/findit/web/_samples && echo "no samples in image"'

# 3. Nginx and certificate (replace findit.example.com in both site files with the real domain first)
sudo install -d -m 755 /var/www/findit-acme
sudo install -m 644 deploy/nginx/findit-limits.conf /etc/nginx/conf.d/findit-limits.conf
sudo install -m 644 deploy/nginx/findit-proxy.conf /etc/nginx/snippets/findit-proxy.conf
sudo install -m 644 deploy/nginx/findit.bootstrap.conf.example /etc/nginx/conf.d/findit.conf
sudo nginx -t && sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/findit-acme -d <domain> --deploy-hook "systemctl reload nginx"
sudo install -m 644 deploy/nginx/findit.conf.example /etc/nginx/conf.d/findit.conf
sudo nginx -t && sudo systemctl reload nginx
```

Compose refuses to start without `FINDIT_MODEL_DIR_HOST`, `FINDIT_SOURCE_URL` and
`FINDIT_COMMIT`. If no other site listens on IPv6 port 443, remove `listen [::]:443 ssl;` from
the site file. `deploy/nginx/check-config.sh` runs `nginx -t` against both site files locally
with Docker and a throwaway certificate (it needs a running Docker daemon).
