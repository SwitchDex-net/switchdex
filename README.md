# SwitchDex

**Open-source network infrastructure monitoring for small business.**

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
- **Auth** — local accounts + optional LDAP / Active Directory, with role-based access

## Quick start

The fastest way to try it (simulation mode — no hardware needed):

```bash
git clone https://github.com/switchdex-net/switchdex.git
cd switchdex
cp .env.example .env        # or let install.sh generate secrets
docker compose up -d --build
```

Then browse to `https://localhost` (accept the self-signed cert). Find the
bootstrap admin password with:

```bash
docker compose logs backend | grep -A4 "bootstrap admin"
```

## Deployment options

| Method | Best for | Guide |
|--------|----------|-------|
| **VM appliance** (OVA / qcow2) | Production, VMware/Proxmox shops | [docs/BUILD.md](docs/BUILD.md), [docs/DEPLOY.md](docs/DEPLOY.md) |
| **Proxmox LXC** (one command) | Proxmox homelab / SMB | [proxmox/README.md](proxmox/README.md) |
| **Bare-metal installer** | An existing Linux VM | `install.sh` |
| **Docker Compose** | Development | this page |

To manage real devices instead of the simulated demo, set `DEVICE_BACKEND=real`
in `.env` and add SSH/SNMP credentials.

## Repository layout

```
switchdex/
├── backend/          FastAPI app — API, device drivers, scheduler, engines
├── frontend/         React single-file UI + standalone API client
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

SwitchDex runs in **simulation mode** out of the box so you can explore the whole
product with no hardware. Real-device support uses NAPALM / Netmiko / asyncssh
(open protocols) and the UniFi / Omada controller APIs (read-only).

## Contributing

Issues and pull requests are welcome. By contributing you agree your
contributions are licensed under the project's license below.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 SwitchDex.
