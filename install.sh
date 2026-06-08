#!/usr/bin/env bash
# One-command install on a fresh Linux VM (the non-appliance path).
# Installs Docker if missing, generates secrets, and brings the stack up.
set -euo pipefail

echo "==> SwitchDex installer"

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Docker not found — installing"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

if [ ! -f .env ]; then
  echo "==> Generating .env with random secrets"
  # head closes the pipe after N chars, so tr gets SIGPIPE — harmless, but
  # silence its stderr so the install output doesn't show a scary "broken pipe".
  rand() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-40}"; }
  IP=$(hostname -I | awk '{print $1}')
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 48)|" \
      -e "s|^SECRET_KEY=.*|SECRET_KEY=$(rand 64)|" \
      -e "s|^PUBLIC_HOSTNAME=.*|PUBLIC_HOSTNAME=${IP:-localhost}|" \
      .env.example > .env
  chmod 600 .env
fi

echo "==> Building and starting the stack"
docker compose up -d --build

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "==> SwitchDex is starting. Open:  https://${IP:-localhost}"
echo "==> (Self-signed cert — accept the browser warning, or set PUBLIC_HOSTNAME in .env.)"
