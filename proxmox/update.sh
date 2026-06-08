#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# SwitchDex — update an existing LXC deployment.
#
# Run ON THE PROXMOX HOST:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/main/proxmox/update.sh)" -- <CTID> [channel] [options]
#
# Arguments:
#   <CTID>            (required) the LXC container id, e.g. 201
#   [channel]         (optional) one of:
#                       (omitted)  → latest tagged release (default, recommended)
#                       main       → bleeding-edge main branch (untested commits)
#                       vX.Y.Z     → a specific release tag (pin / rollback)
#
# Options:
#   --no-snapshot     skip the pre-update Proxmox snapshot
#
# Data persists in Docker volumes (pg_data, config_repo), so inventory, config
# archive, telemetry, alerts, and automations survive the update.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

GN=$'\033[1;92m'; RD=$'\033[01;31m'; YW=$'\033[1;33m'; BL=$'\033[1;34m'; CL=$'\033[m'
info() { echo -e " ${GN}✓${CL} $1"; }
warn() { echo -e " ${YW}!${CL} $1"; }
die()  { echo -e " ${RD}✗${CL} $1" >&2; exit 1; }

REPO="https://github.com/switchdex-net/switchdex.git"
API="https://api.github.com/repos/switchdex-net/switchdex/releases/latest"

# ── parse args ──────────────────────────────────────────────────────────────
CTID=""; CHANNEL=""; DO_SNAPSHOT=1
for a in "$@"; do
  case "$a" in
    --no-snapshot) DO_SNAPSHOT=0 ;;
    --*)           die "Unknown option: $a" ;;
    *)             if [ -z "$CTID" ]; then CTID="$a"; else CHANNEL="$a"; fi ;;
  esac
done
[ -n "$CTID" ] || die "Usage: update.sh <container-id> [channel] [--no-snapshot]"
command -v pct >/dev/null 2>&1 || die "'pct' not found — run on the Proxmox host."
pct status "$CTID" >/dev/null 2>&1 || die "Container $CTID not found."

# ── resolve target ref ──────────────────────────────────────────────────────
if [ -z "$CHANNEL" ]; then
  info "Detecting latest release..."
  TARGET="$(curl -fsSL "$API" 2>/dev/null | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$TARGET" ] || die "Could not detect latest release tag. Pass a channel explicitly (main or vX.Y.Z)."
  info "Latest release: ${BL}${TARGET}${CL}"
else
  TARGET="$CHANNEL"
  info "Target channel: ${BL}${TARGET}${CL}"
fi

# ── show current version ────────────────────────────────────────────────────
BEFORE="$(pct exec "$CTID" -- bash -c "grep -m1 '\"version\"' /opt/switchdex/frontend/package.json 2>/dev/null | sed -E 's/.*\"version\": *\"([^\"]+)\".*/\1/'" 2>/dev/null || echo "unknown")"
echo -e " ${BL}Current version:${CL} ${BEFORE:-unknown}"

# ── optional snapshot ───────────────────────────────────────────────────────
if [ "$DO_SNAPSHOT" -eq 1 ]; then
  SNAP="preupdate-$(date +%Y%m%d-%H%M%S)"
  info "Taking snapshot '${SNAP}' (use --no-snapshot to skip)..."
  if pct snapshot "$CTID" "$SNAP" >/dev/null 2>&1; then
    info "Snapshot created — roll back with: pct rollback ${CTID} ${SNAP}"
  else
    warn "Snapshot failed (low disk, or storage doesn't support snapshots) — continuing without it."
  fi
else
  warn "Snapshot skipped (--no-snapshot)."
fi

# ── update inside the container ─────────────────────────────────────────────
info "Updating SwitchDex in container ${CTID} to ${TARGET}..."
pct exec "$CTID" -- env TARGET="$TARGET" bash -euo pipefail <<'UPDATE'
cd /opt/switchdex || { echo "!! /opt/switchdex not found"; exit 1; }
echo "==> Fetching ${TARGET}"
git fetch --tags --force origin >/dev/null 2>&1
# check out the requested ref: a tag, a branch, or a commit — all work with reset
if git rev-parse "origin/${TARGET}" >/dev/null 2>&1; then
  git reset --hard "origin/${TARGET}"          # branch (e.g. main)
else
  git reset --hard "${TARGET}"                 # tag (e.g. v2.0.2) or commit
fi
echo "==> Rebuilding (clean backend so dependency changes always take)"
# --no-cache on backend/scheduler guarantees requirements.txt changes are
# actually reinstalled; the frontend (caddy) rebuilds too so UI stays in sync.
docker compose build --no-cache backend scheduler
docker compose build caddy
docker compose up -d --force-recreate
echo "==> Pruning old images"
docker image prune -f >/dev/null 2>&1 || true
UPDATE

# ── show new version ────────────────────────────────────────────────────────
sleep 3
AFTER="$(pct exec "$CTID" -- bash -c "grep -m1 '\"version\"' /opt/switchdex/frontend/package.json 2>/dev/null | sed -E 's/.*\"version\": *\"([^\"]+)\".*/\1/'" 2>/dev/null || echo "unknown")"
echo
info "Update complete. Data volumes preserved."
echo -e " ${BL}${BEFORE:-unknown}${CL} → ${GN}${AFTER:-unknown}${CL}"
echo " Accept the self-signed cert and hard-reload the browser (Ctrl+Shift+R) to pick up UI changes."
