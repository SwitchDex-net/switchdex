#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────
# SwitchDex — Proxmox VE LXC installer (self-hosted edition)
#
# Run this ON THE PROXMOX HOST (as root). It creates a Debian 12 LXC container,
# installs Docker, deploys the SwitchDex stack inside it, generates secrets,
# and starts it — leaving you a one-URL login.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v1.6.0/proxmox/switchdex.sh)"
#
# Docker-in-LXC: the container is created unprivileged with nesting+keyctl
# enabled, which is what Docker needs to run inside an LXC.
#
# This is the community-scripts-style helper; it deliberately mirrors their
# prompts/flow so it can later be submitted to community-scripts.org as a
# proper ct/ + install/ pair. Until then it's served from GitHub raw so the
# source you pipe to bash is auditable in one file.
# ──────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── pretty output ─────────────────────────────────────────────────────────
RD=$'\033[01;31m'; GN=$'\033[1;92m'; YW=$'\033[33m'; BL=$'\033[36m'; CL=$'\033[m'
info()  { echo -e " ${GN}✓${CL} $1"; }
warn()  { echo -e " ${YW}!${CL} $1"; }
err()   { echo -e " ${RD}✗${CL} $1" >&2; }
die()   { err "$1"; exit 1; }
header() {
cat <<'EOF'

   ____          _ _      _    ____
  / ___|_      _(_) |_ __| |__|  _ \  _____  __
  \___ \ \ /\ / / | __/ __| '_ \ | | |/ _ \ \/ /
   ___) \ V  V /| | || (__| | | | |_| |  __/>  <
  |____/ \_/\_/ |_|\__\___|_| |_|____/ \___/_/\_\

  Network Infrastructure Monitoring — Proxmox LXC installer
EOF
}

# ── must run on a Proxmox host ──────────────────────────────────────────────
[ "$(id -u)" -eq 0 ] || die "Run as root on the Proxmox host."
command -v pct >/dev/null 2>&1 || die "'pct' not found — this must run on a Proxmox VE host."

header

# ── defaults (overridable by prompts) ───────────────────────────────────────
DEFAULT_HOSTNAME="switchdex"
DEFAULT_DISK="8"        # GB
DEFAULT_CPU="2"
DEFAULT_RAM="4096"      # MB
DEFAULT_BRIDGE="vmbr0"
TEMPLATE_BASE="debian-12-standard"

# ── pick a container ID ─────────────────────────────────────────────────────
NEXTID="$(pvesh get /cluster/nextid 2>/dev/null || pvesh get /cluster/nextid 2>/dev/null || echo 100)"
read -rp "Container ID [${NEXTID}]: " CTID; CTID="${CTID:-$NEXTID}"
pct status "$CTID" >/dev/null 2>&1 && die "Container $CTID already exists."

read -rp "Hostname [${DEFAULT_HOSTNAME}]: " HOSTNAME; HOSTNAME="${HOSTNAME:-$DEFAULT_HOSTNAME}"
read -rp "Cores [${DEFAULT_CPU}]: " CORES; CORES="${CORES:-$DEFAULT_CPU}"
read -rp "RAM in MB [${DEFAULT_RAM}]: " RAM; RAM="${RAM:-$DEFAULT_RAM}"
read -rp "Disk in GB [${DEFAULT_DISK}]: " DISK; DISK="${DISK:-$DEFAULT_DISK}"
read -rp "Network bridge [${DEFAULT_BRIDGE}]: " BRIDGE; BRIDGE="${BRIDGE:-$DEFAULT_BRIDGE}"

echo
echo " Network for the container:"
echo "   1) DHCP (default)"
echo "   2) Static IP"
read -rp " Choice [1]: " NETCHOICE; NETCHOICE="${NETCHOICE:-1}"
if [ "$NETCHOICE" = "2" ]; then
  read -rp "   IP/CIDR (e.g. 10.0.0.50/24): " CIDR
  read -rp "   Gateway (e.g. 10.0.0.1): " GW
  NETCONF="name=eth0,bridge=${BRIDGE},ip=${CIDR},gw=${GW}"
else
  NETCONF="name=eth0,bridge=${BRIDGE},ip=dhcp"
fi

# ── storage pool ────────────────────────────────────────────────────────────
STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR==2{print $1}')"
STORAGE="${STORAGE:-local-lvm}"
read -rp "Storage pool [${STORAGE}]: " S; STORAGE="${S:-$STORAGE}"

# ── fetch a Debian template if needed ───────────────────────────────────────
info "Locating Debian 12 LXC template..."
pveam update >/dev/null 2>&1 || true
TEMPLATE="$(pveam available --section system 2>/dev/null | awk -v b="$TEMPLATE_BASE" '$2 ~ b {print $2}' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || die "No ${TEMPLATE_BASE} template found via pveam."
TPL_STORE="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR==2{print $1}')"; TPL_STORE="${TPL_STORE:-local}"
if ! pveam list "$TPL_STORE" 2>/dev/null | grep -q "$TEMPLATE"; then
  info "Downloading template ${TEMPLATE}..."
  pveam download "$TPL_STORE" "$TEMPLATE" >/dev/null || die "Template download failed."
fi
TEMPLATE_REF="${TPL_STORE}:vztmpl/${TEMPLATE}"

# ── create the container (Docker-in-LXC: nesting + keyctl) ──────────────────
info "Creating LXC ${CTID} (${CORES} cores, ${RAM}MB RAM, ${DISK}GB disk)..."
pct create "$CTID" "$TEMPLATE_REF" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "$NETCONF" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 \
  --onboot 1 \
  --description "SwitchDex — network infrastructure monitoring" \
  >/dev/null || die "pct create failed."

info "Starting container..."
pct start "$CTID" >/dev/null
sleep 5

# ── install everything inside the container ─────────────────────────────────
info "Installing SwitchDex inside the container (this takes a few minutes)..."
pct exec "$CTID" -- bash -euo pipefail <<'CONTAINER_SETUP'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl git >/dev/null

echo "==> Installing Docker"
curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
systemctl enable --now docker >/dev/null 2>&1

echo "==> Fetching SwitchDex stack"
mkdir -p /opt/switchdex
cd /opt/switchdex
# Clones the default branch. Reproducibility comes from which tagged version of
# THIS script you ran (the curl URL is pinned to a release tag). To pin the stack
# too, add: --branch vX.Y.Z
if ! git clone --depth 1 https://github.com/switchdex-net/switchdex.git . >/dev/null 2>&1; then
  echo "!! Could not clone the SwitchDex repo. Place the stack in /opt/switchdex"
  echo "!! and re-run: cd /opt/switchdex && docker compose up -d --build"
  exit 0
fi

echo "==> Generating secrets"
rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-40}"; }
IP=$(hostname -I | awk '{print $1}')
if [ -f .env.example ] && [ ! -f .env ]; then
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand 48)|" \
      -e "s|^SECRET_KEY=.*|SECRET_KEY=$(rand 64)|" \
      -e "s|^PUBLIC_HOSTNAME=.*|PUBLIC_HOSTNAME=${IP:-localhost}|" \
      .env.example > .env
  chmod 600 .env
fi

echo "==> Building and starting the stack"
docker compose up -d --build >/dev/null 2>&1

echo "==> Installing autostart unit"
cat > /etc/systemd/system/switchdex.service <<'UNIT'
[Unit]
Description=SwitchDex stack
Requires=docker.service
After=docker.service
[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/switchdex
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
[Install]
WantedBy=multi-user.target
UNIT
systemctl enable switchdex.service >/dev/null 2>&1
CONTAINER_SETUP

# ── done ────────────────────────────────────────────────────────────────────
CTIP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo
info "SwitchDex is installed in container ${CTID}."
echo
echo -e " ${BL}Open:${CL}   https://${CTIP:-<container-ip>}"
echo -e " ${BL}Admin:${CL}  the bootstrap password is printed in the backend logs:"
echo -e "         ${YW}pct exec ${CTID} -- docker compose -f /opt/switchdex/docker-compose.yml logs backend | grep -A4 'bootstrap admin'${CL}"
echo
echo " Accept the self-signed certificate, then change the admin password on first login."
echo " Runs in real-device mode by default — add your devices in the UI."
echo " (For a hardware-free demo: set SEED_DEMO_DEVICES=true and DEVICE_BACKEND=sim in"
echo "  /opt/switchdex/.env, then: pct exec ${CTID} -- bash -c 'cd /opt/switchdex && docker compose up -d')"
echo
