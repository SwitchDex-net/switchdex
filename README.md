<p align="center">
  <img src="brand/logo.svg" width="96" height="96" alt="SwitchDex logo">
</p>

<h1 align="center">SwitchDex</h1>

<p align="center"><strong>Open-source network infrastructure monitoring for small business.</strong></p>

SwitchDex is a vendor-neutral platform for discovering, monitoring, and managing
your network — switches, routers, firewalls — plus read-only visibility into
closed ecosystems like Ubiquiti UniFi and TP-Link Omada. It's built to be
self-hosted and easy to deploy: import a VM appliance, run one command on
Proxmox, or `docker compose up`.

```
Browser ──HTTPS/WSS──▶ SwitchDex ──SSH / SNMP / NETCONF / controller APIs──▶ Devices
 (no creds)            (creds, scheduler, git archive, telemetry, DB)        (mgmt net)
```

Device credentials live on the server, never in the browser.

## Features

- **Inventory & discovery** — probe devices by SNMP/SSH, auto-identify vendor/model/OS
- **Switch faceplate & port config** — click a port, edit it, with a live CLI preview
- **SSH terminal** — full in-browser terminal proxied to the device
- **Config archive** — git-backed running-config history with diffs, change detection, and restore
- **Topology** — auto-generated network map (force-directed or layered) from neighbor data
- **Alerting** — preset + custom rules, full open→ack→resolve lifecycle, with email / webhook / syslog / Discord notifications
- **Compliance** — policy checks (required/forbidden config) plus per-device golden-baseline drift
- **Telemetry** — time-series CPU, memory, reachability, and per-interface throughput, with inline sparklines and a full charts view
- **Closed ecosystems** — read-only metrics from UniFi and Omada controllers, clearly marked
- **Auth** — local accounts + optional LDAP / Active Directory, role-based access, and a forced password change for the break-glass admin on first login

## Quick start

```bash
git clone https://github.com/switchdex-net/switchdex.git
cd switchdex
cp .env.example .env        # or let install.sh generate secrets
docker compose up -d --build
```

Then browse to `https://localhost` (accept the self-signed cert). Retrieve the
one-time bootstrap admin password from the logs, then log in — you'll be required
to set your own password on first login:

```bash
docker compose logs backend | grep -A4 "bootstrap admin"
```

A fresh install starts **empty and in real-device mode** — add your own devices
(SSH/SNMP). To explore the product with no hardware, build with the demo enabled:
set `DEVICE_BACKEND=sim` and `SEED_DEMO_DEVICES=true` in `.env` before starting,
which populates a few simulated devices with live-looking data.

## Deployment options

| Method | Best for | Guide |
|--------|----------|-------|
| **VM appliance** (OVA / qcow2) | Production, VMware/Proxmox shops | [docs/BUILD.md](docs/BUILD.md), [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Proxmox LXC** (one command) | Proxmox homelab / SMB | [proxmox/README.md](proxmox/README.md) |
| **Bare-metal installer** | An existing Linux VM | `install.sh` |
| **Docker Compose** | Development | this page |

A fresh install runs in real-device mode and starts with an empty inventory; add
your devices in the UI with SSH or SNMP credentials. For a hardware-free demo,
set `DEVICE_BACKEND=sim` and `SEED_DEMO_DEVICES=true` in `.env`.

## Repository layout

```
switchdex/
├── backend/          FastAPI app — API, device drivers, scheduler, engines
├── frontend/         React UI (Vite) + standalone API client; built into the image
├── appliance/        Packer pipeline that builds the OVA / qcow2 image
├── proxmox/          Proxmox LXC install + update scripts
├── docs/             Build, deploy, and backend architecture guides
├── docker-compose.yml
├── Caddyfile         TLS front door + reverse proxy
└── .env.example      configuration template
```

Architecture details and the full API reference are in
[docs/BACKEND.md](docs/BACKEND.md). Wiring the frontend to the backend is covered
in [frontend/INTEGRATION.md](frontend/INTEGRATION.md).

## Status

SwitchDex runs in **real-device mode by default** — a fresh install is an empty,
production-ready inventory you populate with your own gear. Real-device support
uses NAPALM / Netmiko / asyncssh and SNMP for open protocols, plus the UniFi /
Omada controller APIs (read-only). A built-in simulation mode
(`DEVICE_BACKEND=sim`, `SEED_DEMO_DEVICES=true`) lets you explore the entire
product with no hardware.

## Contributing

Issues and pull requests are welcome. By contributing you agree your
contributions are licensed under the project's license below.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 SwitchDex.
