#!/usr/bin/env bash
# nginx -t with Nginx 1.24.0 for both site files and the proxy snippet, using a throwaway
# self-signed certificate at the certificate path. Pulls the pinned nginx image if missing.
set -euo pipefail
cd "$(dirname "$0")"
image="nginx:1.24.0-alpine@sha256:77e5d4a6ad906c5d3793764085706577fa705b1dc6f244ea0241c4b5e2155385"
domain="findit.example.com"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=$domain" \
  -keyout "$work/privkey.pem" -out "$work/fullchain.pem" >/dev/null 2>&1
chmod 644 "$work/"*.pem

check() {  # site file
  docker run --rm \
    -v "$PWD/findit-proxy.conf:/etc/nginx/snippets/findit-proxy.conf:ro" \
    -v "$PWD/$1:/etc/nginx/conf.d/default.conf:ro" \
    -v "$work:/etc/letsencrypt/live/$domain:ro" \
    --entrypoint nginx "$image" -t 2>&1 | grep -E "syntax is ok|test is successful|emerg|warn" || true
}

status=0
for site in findit.bootstrap.conf.example findit.conf.example; do
  echo "== $site (nginx 1.24.0)"
  out="$(check "$site")"
  echo "$out"
  echo "$out" | grep -q "test is successful" || status=1
done
[ "$status" -eq 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
