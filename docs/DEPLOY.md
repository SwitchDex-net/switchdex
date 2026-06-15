# Deploying the SwitchDex appliance (operator guide)

This is the short, non-technical walkthrough for the person installing the
appliance at a small-business site. No command line required.

## What you received
A single image file, one of:
- `switchdex-<version>.ova`   — for VMware ESXi, Workstation, or VirtualBox
- `switchdex-<version>.qcow2`  — for Proxmox VE or any KVM/libvirt host

## Requirements
- A hypervisor (ESXi, Proxmox, VirtualBox, etc.)
- The VM must reach your **management network** — the subnet your switches,
  routers, and firewalls answer on (SSH/22, SNMP/161, NETCONF/830).

### Minimum specs
**2 vCPU · 4 GB RAM · 40 GB disk.** This is the floor — enough to run the full
stack (backend, scheduler, Postgres, Caddy) and monitor a small fleet
comfortably. It's the installer default and is fine for evaluation and for most
small deployments (roughly up to ~50 devices, depending on how many interfaces
each device exposes).

### Recommended specs by fleet size
Pick based on the number of devices **and** their interface count — SwitchDex
samples per-interface throughput every 60s, so a fleet of port-dense switches
generates far more metric volume than the same number of APs or firewalls.

| Fleet size | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| Lab / eval (<25 devices) | 2 | 4 GB | 40 GB | Installer default; minimum spec |
| Small (≤50 devices) | 2 | 4 GB | 40 GB | Comfortable at this size |
| Small-medium (50–150) | 2–4 | 8 GB | 80 GB | Bump RAM as interface count grows |
| Mid-size (150–500) | 4 | 16 GB | 160 GB | Postgres working set grows notably |
| Large (500–2000) | 8 | 32 GB | 320 GB+ | Consider external/managed Postgres |

Why RAM scales: the backend and the scheduler each run as their own process, and
Postgres holds the active metrics working set. More devices — and especially more
*interfaces* — mean more concurrent collection and a larger query set, which is
what pushes memory rather than CPU (CPU stays bursty, not sustained).

### What uses disk
Two things: Docker images / OS (a few GB, fixed) and the time-series metrics
database. Metric volume scales with **interface count**, not just device count,
because per-interface throughput is sampled every 60s. A daily maintenance job
downsamples raw samples to hourly after 7 days and prunes hourly data after 90
days (tunable via `METRICS_RAW_RETENTION_DAYS` / `METRICS_HOURLY_RETENTION_DAYS`
in `.env`), which caps steady-state growth — but the raw window still means a
busy switch with many active ports generates a meaningful number of rows. The
disk figures above include headroom for this. Config history is text in git and
compresses heavily (a few hundred MB/year even at 150 devices), so it's a minor
contributor. For large fleets, raise `BACKUP_CONCURRENCY` in `.env` to speed the
nightly backup.

## Import & power on

### VMware / VirtualBox (.ova)
1. **File → Import Appliance / Deploy OVF**, choose the `.ova`.
2. Put the VM's network adapter on the management VLAN/network.
3. Power on.

### Proxmox (.qcow2)
1. Copy the qcow2 to the node, then create a VM and import the disk:
   ```
   qm importdisk <vmid> switchdex-<version>.qcow2 local-lvm
   ```
2. Attach the imported disk, set the NIC to your management bridge.
3. Power on.

## First boot — network setup wizard (on the VM console)
**Open the VM's console** for the first boot. Before anything starts, a setup
wizard appears:

```
 ┌────────────────────────────────────────────────────────┐
 │              SwitchDex — Network Setup                  │
 ├────────────────────────────────────────────────────────┤
 │ This appliance manages your network, so a STATIC address │
 │ is strongly recommended for production.                  │
 └────────────────────────────────────────────────────────┘
   Detected interface: eth0

   1) Static IP   (recommended — default)
   2) DHCP        (evaluation only)

   Choice [1]:
```

- **Static (default):** enter IP/prefix (e.g. `10.20.0.50/24`), gateway, DNS, and
  — if the NIC is on a trunk port — an optional **management VLAN ID**. The
  appliance configures a tagged subinterface so it lands on the right VLAN
  immediately.
- **DHCP:** press `2` for evaluation only.

This is asked **once**. After the network is set, the appliance generates its own
unique secrets, then starts the stack (1–2 minutes). The console prints the URL
when ready:

```
==> SwitchDex is available at: https://10.20.0.50
```

## Log in
1. Browse to `https://<the-ip-shown>`.
2. The certificate is self-signed by the appliance — accept the browser warning.
   (For a trusted cert, set `PUBLIC_HOSTNAME` to a DNS name in
   `/opt/switchdex/.env` and the appliance will obtain one automatically.)

## Running behind a reverse proxy (NGINX Proxy Manager, Traefik, etc.)
If you front SwitchDex with a reverse proxy that terminates TLS, set `TLS_MODE`
in `/opt/switchdex/.env` so Caddy serves **plain HTTP** instead of a self-signed
cert — this avoids 502 / upstream-certificate-verification errors at the proxy:

```
TLS_MODE=http
```
Then `cd /opt/switchdex && docker compose up -d --force-recreate caddy`.

Point your proxy at **`http://<appliance-ip>:80`** (scheme `http`). The proxy
handles the public certificate; the internal hop is plain HTTP on your LAN.

`TLS_MODE` accepts:
- `internal` (default) — self-signed cert for direct IP/localhost access.
- `auto` — real Let's Encrypt cert (requires a public, resolvable `PUBLIC_HOSTNAME`).
- `http` — plain HTTP, for behind a TLS-terminating reverse proxy.

**Enable WebSocket support** on the proxy host so the in-browser SSH console
(`/ws/*`) works. In NGINX Proxy Manager that's the "Websockets Support" toggle.

## Connect to real devices
Out of the box the appliance runs in **simulation mode** so you can explore it
immediately. To manage real hardware:
1. SSH/console into the appliance (user `switchdex` — you'll be prompted to set
   a new password on first login).
2. Edit `/opt/switchdex/.env`: set `DEVICE_BACKEND=real` and your default
   SSH/SNMP credentials.
3. `cd /opt/switchdex && docker compose up -d`
4. In the web UI, use **Add device** to discover and onboard your switches.

## Day-to-day
- The stack auto-starts on every boot (systemd `switchdex.service`).
- Scheduled config backups run nightly (default 02:00); change detection stores
  a new version only when a config actually changed.
- Everything persists in Docker volumes (`pg_data`, `config_repo`). Snapshot the
  VM to back up the whole instance.

## Changing the network later
The wizard runs only on first boot. To re-address the appliance afterward:
```
sudo rm /opt/switchdex/.netcfg-done
sudo systemctl start switchdex-netsetup    # re-runs the wizard on this console
```
Or edit `/etc/netplan/99-switchdex.yaml` directly and run `sudo netplan apply`.
If the IP changes, update `PUBLIC_HOSTNAME` in `/opt/switchdex/.env` and
`docker compose up -d` so the TLS cert matches.

## Updating
```
cd /opt/switchdex
git pull            # or drop in a new release
docker compose up -d --build
```
