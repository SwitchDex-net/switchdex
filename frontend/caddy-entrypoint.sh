#!/bin/sh
# Translate the user-friendly TLS_MODE into the Caddy variables the Caddyfile
# expects, then hand off to Caddy. Keeps the Caddyfile static while letting one
# .env setting switch between self-signed, real-cert, and behind-proxy (HTTP).
#
# IMPORTANT: the Caddyfile references {$SITE_ADDRESS}, {$TLS_DIRECTIVE} and
# {$CADDY_GLOBAL_EXTRA} WITHOUT defaults — Caddy does not support a nested
# {$VAR:default} as a default value (it's a parse error), so every variable is
# always exported here, in every mode.
set -e

HOST="${PUBLIC_HOSTNAME:-localhost}"

case "${TLS_MODE:-internal}" in
  http)
    # Plain HTTP on :80 — for running behind a reverse proxy that terminates TLS.
    # Bind to :80 (any host) rather than http://<hostname> so the proxy's Host
    # header (the public DNS name, not PUBLIC_HOSTNAME) still routes in.
    export SITE_ADDRESS=":80"
    export TLS_DIRECTIVE=""                    # no TLS in http mode
    export CADDY_GLOBAL_EXTRA="auto_https off"
    echo "[switchdex] TLS_MODE=http — serving plain HTTP on :80 (terminate TLS at your proxy)"
    ;;
  auto)
    # Real Let's Encrypt cert. Requires a resolvable public PUBLIC_HOSTNAME.
    export SITE_ADDRESS="${HOST}"
    export TLS_DIRECTIVE=""                    # empty = Caddy default automatic HTTPS (LE)
    export CADDY_GLOBAL_EXTRA="default_sni ${HOST}"
    echo "[switchdex] TLS_MODE=auto — requesting a real certificate for ${HOST}"
    ;;
  internal|*)
    # Self-signed cert from Caddy's internal CA (direct IP / localhost access).
    # default_sni is required so bare-IP access (no SNI from the client) still
    # gets a cert presented instead of a TLS handshake error.
    export SITE_ADDRESS="${HOST}"
    export TLS_DIRECTIVE="tls internal"
    export CADDY_GLOBAL_EXTRA="default_sni ${HOST}"
    echo "[switchdex] TLS_MODE=internal — self-signed certificate (accept the browser warning)"
    ;;
esac

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
