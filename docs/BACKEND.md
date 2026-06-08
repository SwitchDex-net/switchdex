# SwitchDex — Backend & Appliance

Open-source, vendor-neutral network management. This repository is the
**server side**: the API, device-access layer, config archive, scheduler, and
the build pipeline that packages everything into a turnkey VM appliance.

The browser only ever talks to this backend over HTTPS/WebSocket. Device
credentials live here, never in the browser:

```
Browser ──HTTPS/WSS──▶ SwitchDex backend ──SSH / SNMP / NETCONF──▶ Devices
 (no creds)            (creds, scheduler,                          (mgmt net)
                        git archive, DB)
```

## Four ways to run it

### 1. Appliance image (recommended for small-business production)
Build once, ship one file. The operator imports it and powers on — no Docker,
no command line.

```
cd appliance
make build VERSION=1.6.0
# -> output/switchdex-1.6.0.qcow2   (KVM / Proxmox)
# -> output/switchdex-1.6.0.ova     (VMware / VirtualBox)
```

On first power-on the image generates its own random secrets, detects its IP,
and starts the stack. The operator just browses to `https://<appliance-ip>`.

### 2. Proxmox LXC (one command, lightest install)
On the Proxmox host:
```
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/v2.0.0/proxmox/switchdex.sh)"
```
Creates a Debian LXC (Docker-in-LXC, nesting+keyctl enabled), deploys the stack,
generates secrets, and auto-starts it. See `proxmox/README.md`. Update later with
`proxmox/update.sh`.

### 3. One-command install on an existing VM
```
git clone https://github.com/switchdex-net/switchdex.git && cd switchdex
sudo ./install.sh        # installs Docker if needed, generates secrets, starts up
```

### 4. Manual (for development)
```
cp .env.example .env     # edit secrets
docker compose up -d --build
```

## Services (the whole stack)

| Service     | Role                                                        |
|-------------|-------------------------------------------------------------|
| `caddy`     | TLS termination, serves the frontend, proxies API + WS      |
| `backend`   | FastAPI — REST API + WebSocket SSH proxy                    |
| `scheduler` | Daily config backups + change detection                    |
| `db`        | Postgres — inventory, archive metadata                     |
| (volume) `config_repo` | Git repo — the actual running-config archive     |

## Device access — `sim` vs `real`

`DEVICE_BACKEND` in `.env`:

- **`sim`** (default): simulated devices, so the appliance works end-to-end with
  zero hardware. Great for evaluation and demos.
- **`real`**: talks to live gear via **NAPALM** (structured multi-vendor get/replace),
  **Netmiko** (raw CLI for anything NAPALM doesn't cover), and **asyncssh** (the
  interactive terminal). Flip this one flag to go to production.

Per-device credentials override the global defaults and are stored server-side.

## Key API endpoints (frontend contract)

```
GET    /api/devices                          list inventory
POST   /api/devices/probe                     discovery probe (SNMP/SSH fingerprint)
POST   /api/devices                            add a device (+ initial backup)
GET    /api/devices/{id}/configs               version history
GET    /api/devices/{id}/configs/{vid}         one config version (text)
GET    /api/devices/{id}/configs/diff?a=&b=     diff two versions
POST   /api/devices/{id}/backup                back up now
POST   /api/devices/{id}/restore/{vid}         restore a version (backs up first)
POST   /api/backup-all                          fleet backup
WS     /ws/ssh/{id}                             interactive SSH terminal
```

These mirror exactly what the simulated frontend already calls, so wiring the UI
to this backend is a base-URL change, not a rewrite.

## Telemetry (time-series)

Historical metrics, stored in the existing Postgres (no extra service). The
scheduler samples every device on a configurable interval and writes datapoints
to a `metric_samples` table; a nightly maintenance job downsamples raw rows into
hourly aggregates and prunes by retention window.

- **Collected**: device-level `cpu`, `mem`, `reachable` (status timeline), plus
  per-interface `if_rx` / `if_tx` throughput.
- **Retention** (configurable in `.env`): raw samples kept 7 days, downsampled
  hourly data kept 90 days, sample interval 300s by default.
- **Sources**: controller-managed devices report via their API; open-protocol
  devices would be polled via SNMP/streaming telemetry. Sim mode synthesizes
  smooth series so charts populate with no hardware.

The frontend shows inline CPU/memory sparklines on the device detail panel and a
dedicated Telemetry view with CPU, memory, and per-interface throughput charts
across selectable ranges (1h / 6h / 24h / 7d / 30d). Charts are hand-rolled SVG
(no charting dependency).

```
GET /api/metrics/devices/{id}?metric=cpu&range=24h[&label=]   single series
GET /api/metrics/devices/{id}/interfaces?range=24h            per-interface rx/tx
GET /api/metrics/devices/{id}/summary                          latest cpu/mem
```

## Compliance

Drift detection and config-policy enforcement, built on the archive. Two
complementary models:

- **Policy rules** — fleet-wide `require`/`forbid` checks against config content
  (substring or regex), each with a severity and optional device scope. Ships
  **empty** — admins author all rules (e.g. require `transport input ssh`, forbid
  `snmp-server community public`). Cross-vendor since it matches config text.
- **Baseline drift** — optionally pin a known-good config version as a device's
  golden baseline; drift = current config differs from it (by content hash), with
  an on-demand unified diff.

The dashboard shows a fleet compliance score, per-device pass/fail/drift with
expandable per-check detail, and a policy manager. Read-only controller-managed
devices are excluded (no manageable config). Compliance is dashboard-only for now
(not wired to alerting), evaluated on request.

```
GET    /api/compliance                         fleet dashboard (score + per-device)
GET    /api/compliance/devices/{id}            one device's checks
GET/POST/PUT/DELETE /api/compliance/policies[...]   policy CRUD (admin)
GET    /api/compliance/baselines               list pinned baselines
POST   /api/compliance/baselines/{did}/pin/{vid}    pin golden version (admin)
DELETE /api/compliance/baselines/{did}              unpin (admin)
GET    /api/compliance/devices/{id}/drift      baseline-vs-current diff
```

## Alerting & notifications

A rule engine (in the scheduler, evaluated every 60s) watches device state and
fires alerts with a full lifecycle: **open → acknowledged → resolved** (manual or
auto-resolve when the condition clears).

- **Rules** — presets (device down, high CPU, high memory, config changed) plus
  fully custom metric/operator/threshold rules, each with severity, a `duration`
  debounce ("must hold N seconds"), optional device scope, and auto-resolve.
- **Notifications** — fan out to four channel types: **email** (SMTP),
  **webhook** (Slack/Teams/generic JSON), **syslog** (RFC3164 UDP), and
  **Discord** (rich embed). Each channel has a minimum-severity floor and a Test
  button. Channel failures are isolated so one bad channel never blocks others.
- **Config-change alerts** — the backup engine raises an alert/notification when
  change detection stores a new version, so drift is actively surfaced.

```
GET  /api/alerts[?state=]            list alerts
GET  /api/alerts/summary             open/ack/critical/warning counts
POST /api/alerts/{id}/ack            acknowledge
POST /api/alerts/{id}/resolve        resolve
GET/POST/PUT/DELETE /api/alerts/rules[...]      rule CRUD (admin)
GET/POST/DELETE /api/alerts/channels[...]        channel CRUD (admin)
POST /api/alerts/channels/test       send a test notification (admin)
```

## Topology

`GET /api/topology` returns `{nodes, links}` derived from device data — nodes are
devices, links are LLDP/CDP neighbor relationships (`Device.neighbors_json`). In
sim mode a core/distribution/access/edge hierarchy is inferred from device roles
so the map is populated without live discovery. The frontend renders it two ways
(force-directed and layered-by-role) with clickable nodes that open device detail.
Read-only controller-managed devices appear with a distinct dashed style.

## Closed-ecosystem integrations (UniFi / Omada)

Open-protocol devices (NETCONF/gNMI/SSH) are fully manageable. Closed ecosystems
are integrated **read-only** through their controllers — SwitchDex polls the
controller API rather than each device:

- **UniFi** — UniFi Network Controller REST API (username/password session).
  Read-only: device list, port status/PoE, throughput, clients, CPU/mem.
- **Omada** — TP-Link Omada **Open API** (client-id/secret token). Read-only for
  now; the Open API supports writes, reserved for a future managed mode.
- **SNMP** — universal fallback via the existing discovery probe.

Controller-managed devices are synced into inventory tagged `source` (`unifi`/
`omada`) and `capability: readonly`. The backend **enforces** the read-only
boundary — config backup and the SSH WebSocket are rejected for read-only
devices (HTTP 409 / WS refusal), so the limit isn't just a UI affordance.

```
GET    /api/integrations                  list controllers
POST   /api/integrations                  add a controller (admin)
POST   /api/integrations/test             validate before saving (admin)
POST   /api/integrations/{id}/sync        pull devices now (admin)
DELETE /api/integrations/{id}             remove controller + its devices (admin)
GET    /api/integrations/devices/{id}/metrics   live read-only metrics
```

The scheduler polls all enabled controllers every 5 minutes; read-only devices
are excluded from the nightly config-backup run.

## Authentication

All `/api/*` routes require a JWT bearer token; the WebSocket SSH route takes the
token as `?token=`. Login flow:

- **Local admin** — created automatically on first run with a **random password
  printed to the console** (no shipped default credential). The operator is forced
  to change it on first login.
- **LDAP / Active Directory** — optional, configured at runtime via
  `/api/auth/ldap` (or the Settings screen). When enabled, login tries the
  directory first and falls back to local accounts, so a break-glass admin still
  works if the directory is down. Supports AD (`sAMAccountName`) and OpenLDAP
  (`uid`). Members of the configured **admin group DN** get the admin role; other
  directory users get viewer.

```
POST /api/auth/login            obtain a token (form: username, password)
GET  /api/auth/me               current user
POST /api/auth/change-password  local users only
GET/POST/DELETE /api/auth/users local user management (admin)
GET/PUT /api/auth/ldap          LDAP config (admin)
POST /api/auth/ldap/test        validate LDAP bind before saving (admin)
```

Find the bootstrap admin password in the logs after first start:
```
docker compose logs backend | grep -A4 "bootstrap admin"
```

See `docs/DEPLOY.md` for the operator-facing import/first-boot walkthrough.
