#!/bin/sh
# Translate the user-friendly TLS_MODE into the Caddy variables the Caddyfile
# expects, then hand off to Caddy. Keeps the Caddyfile static while letting one
# .env setting switch between self-signed, real-cert, and behind-proxy (HTTP).
set -e

HOST="${PUBLIC_HOSTNAME:-localhost}"

case "${TLS_MODE:-internal}" in
  http)
    # Plain HTTP on :80 — for running behind a reverse proxy that terminates TLS.
    export SITE_ADDRESS="http://${HOST}"
    export TLS_DIRECTIVE=""           # no tls directive in http mode
    export CADDY_GLOBAL_EXTRA="auto_https off"
    echo "[switchdex] TLS_MODE=http — serving plain HTTP on :80 (terminate TLS at your proxy)"
    ;;
  auto)
    # Real Let's Encrypt cert. Requires a resolvable public PUBLIC_HOSTNAME.
    export SITE_ADDRESS="${HOST}"
    export TLS_DIRECTIVE=""           # empty = Caddy's default automatic HTTPS (LE)
    export CADDY_GLOBAL_EXTRA=""
    echo "[switchdex] TLS_MODE=auto — requesting a real certificate for ${HOST}"
    ;;
  internal|*)
    # Self-signed cert from Caddy's internal CA (direct IP / localhost access).
    export SITE_ADDRESS="${HOST}"
    export TLS_DIRECTIVE="tls internal"
    export CADDY_GLOBAL_EXTRA=""
    echo "[switchdex] TLS_MODE=internal — self-signed certificate (accept the browser warning)"
    ;;
esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
