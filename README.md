<p align="center">
  <img src="brand/logo.svg" width="96" height="96" alt="SwitchDex logo">
</p>

<h1 align="center">SwitchDex</h1>

<p align="center"><strong>Open-source, vendor-neutral network management for small business.</strong></p>

SwitchDex is a vendor-neutral platform for discovering, monitoring, and managing
your network — switches, routers, firewalls — plus read-only visibility into
closed ecosystems like Ubiquiti UniFi and TP-Link Omada. It manages directly
reachable devices over SSH and SNMP (read *and* write, with a safe preview →
confirm → verify flow for every config change) and brings controller-managed
gear into the same inventory as read-only devices. It's built to be self-hosted
and easy to deploy: import a VM appliance, run one command on Proxmox, or
`docker compose up`.

```
Browser ──HTTPS/WSS──▶ SwitchDex ──SSH / SNMP / controller APIs──▶ Devices
 (no creds)            (creds, scheduler, git archive, telemetry, DB)   (mgmt net)
```

Device credentials live on the server, never in the browser.

## Features

- **Inventory & discovery** — probe devices by SNMP or SSH, auto-identify vendor/model/OS, and auto-populate hostname/location from the device (SNMP `sysName`/`sysLocation`)
- **Live interface configuration** — click a port, edit it, and push the change to the device with a **safe apply** flow: SwitchDex previews the exact CLI commands, you confirm, it pushes over SSH and then reads the interface back to verify the change landed
- **Multi-vendor command generation** — interface config is generated per platform: Cisco IOS/NX-OS, Arista EOS, Juniper Junos (set/commit model), SONiC, and Brocade FastIron
- **SSH terminal** — full in-browser terminal proxied to the device, handling legacy crypto on older gear
- **Config archive** — git-backed running-config history with diffs, change detection, and restore
- **Topology** — auto-generated network map (force-directed or layered) from neighbor data
- **Alerting** — preset + custom rules with a full open→ack→resolve lifecycle; notifications are delivered through automations (see below) to email / webhook / syslog / Discord channels
- **Automations** — a trigger → scope → action engine: triggers on alerts, metric thresholds, device-down, vulnerabilities found, config drift, or a schedule; acts on the triggering device or a chosen scope; actions range from notify / backup / scan / raise-alert to remediation (config push, disable interface) gated by dry-run-until-armed, optional approval, cooldown, blast-radius caps, and uplink protection
- **Dashboard** — a configurable fleet overview (KPIs, fleet health, recent alerts, top talkers, client summary) with add/remove/reorder cards
- **Security** — vulnerability scanning that matches each device's software version against CVEs synced from the NIST NVD, with per-device findings by severity and links to NVD; distinguishes "clear" from "no NVD coverage"; can drive alerts and automations
- **Telemetry** — time-series CPU, memory, uptime, and **per-interface throughput** collected over SNMP, with charts and history; AP throughput is derived from client traffic; controller-managed devices are sampled on a slower cadence to respect their API limits
- **Wireless clients** — fleet-wide view of connected wireless clients with per-AP filtering and search
- **Closed ecosystems** — connect UniFi and Omada controllers to pull their devices into inventory as **read-only**, clearly marked, with a one-click deep-link back to the vendor controller for changes
- **Auth** — local accounts + optional LDAP / Active Directory, role-based access, persistent sessions across refresh, and a forced password change for the break-glass admin on first login

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
production-ready inventory you populate with your own gear. Discovery, the SSH
terminal, and live config push use **asyncssh** (handling the legacy key-exchange
and host-key algorithms older switches still require) plus **SNMP** for
fingerprinting and metadata; the config archive uses **NAPALM** for structured
config get/replace. Closed ecosystems connect through the **UniFi / Omada
controller APIs** (read-only). A built-in simulation mode (`DEVICE_BACKEND=sim`,
`SEED_DEMO_DEVICES=true`) lets you explore the entire product with no hardware.

> **Multi-vendor note:** config push is verified against Cisco IOS hardware.
> Arista EOS, Juniper Junos, SONiC, and Brocade command generation is
> implemented and structurally correct but not yet verified against physical
> devices of those vendors — the safe-apply preview lets you review the exact
> commands before anything is sent.

> **Automation remediation note:** the remediation actions (config push, disable
> interface) are implemented with safety rails (dry-run-until-armed, optional
> approval, cooldown, blast-radius cap, uplink protection) but have not yet been
> applied to live devices. Test them in dry-run against your own gear before
> arming. See `CHANGELOG.md` for the full verified / not-yet-verified breakdown.

## Contributing

Issues and pull requests are welcome. By contributing you agree your
contributions are licensed under the project's license below.

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 SwitchDex.
