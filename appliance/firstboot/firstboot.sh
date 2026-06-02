#!/usr/bin/env bash
# Runs ONCE on the operator's first power-on. Turns the generic image into a
# unique, secured instance: random secrets, detected IP, then starts the app.
set -euo pipefail

MARKER=/opt/switchdex/.firstboot-done
ENV=/opt/switchdex/.env
[ -f "$MARKER" ] && exit 0

echo "==> SwitchDex first boot: generating instance configuration"

rand() { tr -dc 'A-Za-z0-9' </dev/urandom | head -c "${1:-40}"; }

# Network was configured by the console wizard (switchdex-netsetup.service),
# which runs Before= this. Read the now-settled primary address.
IP=$(hostname -I | awk '{print $1}')

cat > "$ENV" <<EOF
POSTGRES_USER=switchdex
POSTGRES_PASSWORD=$(rand 48)
POSTGRES_DB=switchdex
SECRET_KEY=$(rand 64)
DEVICE_BACKEND=sim
DEFAULT_SSH_USERNAME=netops
DEFAULT_SSH_PASSWORD=
DEFAULT_SNMP_COMMUNITY=public
BACKUP_HOUR=2
BACKUP_MINUTE=0
BACKUP_CONCURRENCY=10
PUBLIC_HOSTNAME=${IP:-localhost}
EOF
chmod 600 "$ENV"

# Lock down the build/default password — force a new one on console login.
passwd -e switchdex || true

touch "$MARKER"
echo "==> First boot complete."
echo "==> SwitchDex will be available at: https://${IP:-this-host}"
echo "==> (Accept the self-signed certificate, or set PUBLIC_HOSTNAME in $ENV for a real cert.)"
