# Changelog

All notable changes to SwitchDex are recorded here. Versions follow semantic
versioning (MAJOR.MINOR.PATCH).

## [2.0.1]

### Fixed
- **Config push / restore failed with `No module named 'pkg_resources'`.** The
  `setuptools` dependency was pinned `>=70` with no upper bound, so it floated to
  82.x — but setuptools 80 removed `pkg_resources`, which NAPALM's drivers import
  during config push. Capped to `>=70,<80` so `pkg_resources` stays available.
- Pinned `pyeapi==1.0.4` explicitly. NAPALM's Arista EOS driver requires it but
  does not install it automatically, so it could be missing on a fresh install.

### Known limitations
- The remediation **uplink-protection guard does not understand in-band/SVI
  management.** It blocks interfaces by name (uplink/mgmt/trunk/wan), but cannot
  tell that disabling a plain access port might take down the VLAN carrying the
  device's management SVI. On an in-band-managed switch, `disable_interface`
  could sever management even with the guard on. Test remediation against
  non-production devices, and prefer out-of-band management where possible.

## [2.0.0]

A major release centered on **automations** and a reworked **notification model**,
plus substantial monitoring additions. This version contains one breaking change
to how notifications are delivered — see **Breaking changes** below.

### Breaking changes
- **Notifications are now delivered by automations, not directly by alert rules.**
  Previously, an alert firing would notify every channel that met the channel's
  severity threshold. That threshold has been removed, and the alert engine no
  longer sends notifications on its own. To receive notifications, create an
  automation with the trigger **"an alert fires"** (optionally scoped to specific
  alert rules) and a **Send notification** action that selects the target
  channels. **After upgrading, existing alert-based notifications will be silent
  until such an automation is created.** Alerts themselves continue to fire and
  appear in the Alerts view as before.

### Added
- **Automations** — a trigger → scope → action engine.
  - Triggers: event-driven (an alert fires, a metric crosses a threshold, a
    device goes down, a vulnerability is found, config drift) and scheduled (cron).
  - The "an alert fires" trigger can be scoped to specific alert rules.
  - Scope: all devices, by device type, or by role — each optionally narrowed to
    a single device.
  - Actions: notify (with per-automation channel selection), back up config, run
    a CVE scan, raise an alert, push a config snippet, and disable an interface.
  - Event-driven automations act on the triggering device; scheduled automations
    act across their scope.
  - Remediation guardrails: dry-run-until-armed, optional approval queue,
    mandatory cooldown, blast-radius cap, and management/uplink protection.
  - Full run history and a pending-approval queue.
- **Editable dashboard** — a configurable fleet overview (KPIs, fleet health,
  recent alerts, top talkers, client summary) with add/remove/reorder of cards,
  shared org-wide, and set as the default landing view.
- **Wireless Clients** view — fleet-wide list of connected wireless clients with
  per-AP filtering and search.
- **Interface telemetry** — per-interface throughput (SNMP counter deltas) with
  history charts, plus AP throughput derived from client traffic.
- **Throughput surfaced** in the device detail page, the topology QuickView
  drawer, and per-interface views.
- **NVD API key management in the UI** (Settings → API keys) — stored on the
  appliance, applied to scans immediately, no restart needed.
- **Notification channels moved to Settings → Notifications**, shared by alerting
  and automations.
- **CVE "no coverage" state** — distinguishes genuinely clear from "the NVD has no
  records for this product," for devices, controllers, and APs.

### Changed
- OPNsense / pfSense / FreeBSD devices are now classified as **firewalls** rather
  than switches.
- Proxmox installer default disk raised from 8 GB to 40 GB to match the metrics
  database footprint.
- The Proxmox installer now offers an optional **root login** setup (set a root
  password, and optionally enable root SSH). Both default to off — the container
  root account stays locked and is administered from the Proxmox host via
  `pct exec`, which remains the recommended posture.
- Deployment sizing guidance reworked into a documented minimum spec plus
  recommended specs by fleet size.

### Verified on hardware
Interface and AP telemetry, wireless clients, dashboard, the vulnerability-found
automation path (end-to-end), the NVD key UI, and the spec/disk changes have been
exercised against live equipment (a Catalyst 3850, an OPNsense firewall, and Omada
APs).

### Not yet verified on hardware
The following are implemented but not yet validated against live equipment, and
should be tested before relying on them in production:
- Remediation actions (`push_config`, `disable_interface`) — only dry-run logic
  has been exercised; these have never been applied to real devices.
- The replacement notification automations (the new notification model).
- The per-rule trigger filter, per-device scope narrowing, and event scope
  targeting.

## [1.0.0]
- Initial release: device inventory, SSH/SNMP/NETCONF management, configuration
  backup and archive, alerting with notification channels, CVE scanning via the
  NIST NVD, network topology, and Proxmox/appliance deployment.
