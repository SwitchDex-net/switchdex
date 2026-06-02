#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# SwitchDex — update an existing LXC deployment.
#
# Run ON THE PROXMOX HOST:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v1.0.0/proxmox/update.sh)" -- <CTID>
#
# Pulls the latest stack inside the container and recreates the services.
# Data persists in Docker volumes (pg_data, config_repo), so inventory,
# config archive, telemetry, alerts, and compliance survive the update.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

GN=$'\033[1;92m'; RD=$'\033[01;31m'; CL=$'\033[m'
info() { echo -e " ${GN}✓${CL} $1"; }
die()  { echo -e " ${RD}✗${CL} $1" >&2; exit 1; }

CTID="${1:-}"
[ -n "$CTID" ] || die "Usage: update.sh <container-id>"
command -v pct >/dev/null 2>&1 || die "'pct' not found — run on the Proxmox host."
pct status "$CTID" >/dev/null 2>&1 || die "Container $CTID not found."

info "Updating SwitchDex in container ${CTID}..."
pct exec "$CTID" -- bash -euo pipefail <<'UPDATE'
cd /opt/switchdex || { echo "!! /opt/switchdex not found"; exit 1; }
echo "==> Pulling latest"
git pull --ff-only || echo "!! git pull skipped (local changes or detached)"
echo "==> Rebuilding and restarting"
docker compose pull >/dev/null 2>&1 || true
docker compose up -d --build
echo "==> Pruning old images"
docker image prune -f >/dev/null 2>&1 || true
UPDATE

info "Update complete. Data volumes preserved."
