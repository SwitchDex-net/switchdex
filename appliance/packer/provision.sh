#!/usr/bin/env bash
# Runs once inside the VM during the Packer build. Installs Docker, places the
# SwitchDex stack, pre-pulls images, and installs the firstboot service.
set -euo pipefail

echo "==> Installing Docker"
curl -fsSL https://get.docker.com | sh
systemctl enable docker

echo "==> Placing SwitchDex stack in /opt/switchdex"
mkdir -p /opt/switchdex
cp -r /tmp/switchdex/* /opt/switchdex/
rm -rf /opt/switchdex/appliance   # don't ship the build tooling inside the image

echo "==> Pre-building / pre-pulling container images (so first boot is fast)"
cd /opt/switchdex
# Build the backend image and pull the rest now, while we have a network.
docker compose --env-file /dev/null pull caddy db || true
docker compose build backend || true

echo "==> Installing firstboot services"
# Console network wizard (runs first, before the app)
cp /tmp/switchdex/appliance/firstboot/netsetup.sh /opt/switchdex/netsetup.sh
chmod +x /opt/switchdex/netsetup.sh
cp /tmp/switchdex/appliance/firstboot/switchdex-netsetup.service /etc/systemd/system/
systemctl enable switchdex-netsetup.service

# App firstboot (secrets, identity)
cp /tmp/switchdex/appliance/firstboot/firstboot.sh /opt/switchdex/firstboot.sh
chmod +x /opt/switchdex/firstboot.sh
cp /tmp/switchdex/appliance/firstboot/switchdex-firstboot.service /etc/systemd/system/
systemctl enable switchdex-firstboot.service

# Ensure netplan is present for the wizard
apt-get install -y --no-install-recommends netplan.io >/dev/null 2>&1 || true

echo "==> Installing the persistent app service"
cat > /etc/systemd/system/switchdex.service <<'EOF'
[Unit]
Description=SwitchDex stack
Requires=docker.service switchdex-firstboot.service
After=docker.service switchdex-netsetup.service switchdex-firstboot.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/switchdex
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
EOF
systemctl enable switchdex.service

echo "==> Cleaning up"
apt-get clean
cloud-init clean --logs || true
rm -rf /tmp/switchdex
echo "==> Provisioning complete"
