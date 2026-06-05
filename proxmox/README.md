# SwitchDex on Proxmox VE (LXC)

One-command install of SwitchDex into a Proxmox LXC container. Lighter than the
full VM appliance — the container shares the host kernel — and ideal for a
Proxmox homelab or small-business node.

## Install

Run **on the Proxmox host** (as root):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v1.6.0/proxmox/switchdex.sh)"
```

You'll be prompted for container ID, hostname, cores/RAM/disk, network bridge,
and DHCP-vs-static. Defaults (2 cores / 4 GB / 40 GB disk) suit up to ~150
devices. The script then:

1. Downloads a Debian 12 LXC template if needed.
2. Creates an **unprivileged** container with `nesting=1,keyctl=1` enabled
   (required for Docker-in-LXC).
3. Installs Docker, deploys the SwitchDex stack to `/opt/switchdex`, generates
   random secrets, and starts it.
4. Installs a systemd unit so the stack auto-starts on container boot.

When it finishes it prints the URL and how to retrieve the bootstrap admin
password.

## First login

```bash
pct exec <CTID> -- docker compose -f /opt/switchdex/docker-compose.yml \
  logs backend | grep -A4 'bootstrap admin'
```

Browse to `https://<container-ip>`, accept the self-signed certificate, log in as
`admin` with that password, and change it when prompted.

## Update

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v1.6.0/proxmox/update.sh)" -- <CTID>
```

Data lives in Docker volumes (`pg_data`, `config_repo`), so inventory, the config
archive, telemetry, alerts, and compliance all survive updates.

## Manage real devices

Out of the box the stack runs in **simulation mode**. To talk to real hardware:

```bash
pct exec <CTID> -- sed -i 's/^DEVICE_BACKEND=sim/DEVICE_BACKEND=real/' /opt/switchdex/.env
pct exec <CTID> -- bash -c 'cd /opt/switchdex && docker compose up -d'
```

Set default SSH/SNMP credentials in `/opt/switchdex/.env` too (or per-device in
the UI).

## Why Docker-in-LXC

We reuse the exact same Compose stack as the VM appliance and the bare-metal
installer — one stack definition, three delivery methods. The only LXC-specific
requirement is the `nesting`/`keyctl` container features, which the installer
sets automatically. (A privileged container is **not** required.)

## Notes on the community-scripts.org listing

This self-hosted installer deliberately follows the community-scripts flow
(interactive prompts, container creation, in-container install, update helper) so
it can later be submitted to <https://community-scripts.org> as a proper
`ct/switchdex.sh` + `install/switchdex-install.sh` pair. Hosting it on
GitHub keeps the script you pipe to `bash` auditable in one place
while that review process runs.

**Security note:** like all such installers, this runs as root on your
hypervisor and fetches scripts at runtime. Read the source before running it in
production, and pin to a release tag rather than `main` for repeatable installs.
