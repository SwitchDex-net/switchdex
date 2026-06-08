# SwitchDex — Tester Guide

Thanks for helping test SwitchDex. This is **early software (v2.0.2)** — the goal
of this round is to find bugs on real, varied setups. **Install it, use it, and
report what breaks.** Rough edges are expected; that's the point.

---

## Install

Run on a **Proxmox host** (creates an LXC container, ~5 min):

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/main/proxmox/switchdex.sh)"
```

Answer the prompts (container ID, network, etc.), then browse to
`https://<container-ip>`, accept the self-signed certificate, and log in as
`admin`. The bootstrap password is printed in the backend logs:

```bash
pct exec <CTID> -- docker compose -f /opt/switchdex/docker-compose.yml logs backend | grep -A4 "bootstrap admin"
```

You'll be asked to change it on first login.

## Update

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/switchdex-net/switchdex/main/proxmox/update.sh)" -- <CTID>
```

Updates to the latest release, snapshots first, preserves your data.

---

## Please read before testing: known limitations

SwitchDex can read from and **make changes to** real network devices. A few
things are not fully proven yet — knowing these prevents nasty surprises:

- **Config push / remediation is verified on Cisco IOS and Arista EOS only.**
  Juniper, SONiC, and Brocade device support is implemented but **not yet tested
  against real hardware**. If you point SwitchDex at one of those, you're on the
  frontier — great for testing, but expect rough edges. The "preview" / dry-run
  shows the exact commands before anything is sent; use it.

- **⚠ Remediation can cut your own management path.** Automations that disable an
  interface or push a config protect against disabling obviously-named uplinks,
  but they do **not** yet understand in-band/VLAN (SVI) management. Disabling the
  wrong access port on an in-band-managed switch could sever your connection to
  it. **Always dry-run remediation first, and never arm it against a device you
  can't recover via console or physical access.**

- **Arista config push requires eAPI enabled on the device**
  (`management api http-commands` → `no shutdown`). Backup works over SSH, but
  push/restore uses eAPI — if it's off you'll get a connection error.

- **Notifications are sent by Automations, not alert rules directly.** To get
  notified when an alert fires, create an Automation: trigger "an alert fires" →
  action "Send notification" → pick your channel(s). Configure channels in
  Settings → Notifications.

- Self-signed certificate by default; you'll click through a browser warning.

**Don't test write/remediation features against production gear you depend on.**
Use a lab device, or read-only features (discovery, telemetry, backup) on
production.

---

## Reporting bugs

Open an issue at **github.com/switchdex-net/switchdex/issues** using the template
below (also in `.github/ISSUE_TEMPLATE`). The more of it you fill in, the faster
it gets fixed. Copy/paste this if the template isn't showing:

```
**Version:** (Settings, or: pct exec <CTID> -- grep version /opt/switchdex/frontend/package.json)
**What I did:**
**What I expected:**
**What happened:** (exact error text — copy it verbatim)

**Device involved (if any):**
  Vendor / OS / model:
  How managed: SSH / SNMP / eAPI / controller

**Backend logs around the time it happened:**
  pct exec <CTID> -- docker compose -f /opt/switchdex/docker-compose.yml logs --tail 100 backend

**Browser console errors (for UI bugs):** (F12 → Console, copy any red errors)
```

**Most useful things to capture:** the **exact error text** (not a paraphrase),
the **device vendor/OS** if a device was involved, and the **backend logs**
around when it happened. UI bug? Add the browser console (F12) output.

Thanks — every report makes the next build better.
