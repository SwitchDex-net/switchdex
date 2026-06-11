# Changelog

All notable changes to SwitchDex are recorded here. Versions follow semantic
versioning (MAJOR.MINOR.PATCH).

## [2.0.5]

### Added
- **Per-controller poll interval** — each integration now has a configurable sync
  interval (seconds; default 300, min 30). The scheduler honors each controller's
  own interval instead of a fixed global cadence, so a rate-limited cloud
  controller can be dialed down or a local one up, independently.
- **Controller editing** — controllers can now be edited in place (previously
  add/delete only). Stored secrets are preserved when their fields are left blank.

### Fixed
- **UniFi: clients now associate with the correct AP.** Client records carry only
  the AP's MAC, not its name; the connector now resolves the AP name via a
  mac→name map from the device list. Fixes the Wireless Clients view and per-AP
  throughput attribution.
- **UniFi: device CPU/memory metrics now populate.** Read from the `system-stats`
  key (percentages) instead of `sys_stats`, with a fallback for older fields.
- **UniFi: friendly model names.** Ubiquiti reports internal SKU codes (e.g.
  U7PG2); these are now mapped to marketing names (UAP-AC-Pro, etc.). Unknown
  codes pass through unchanged.
- **SNMP devices: hardware model now discovered via ENTITY-MIB.** sysDescr rarely
  contains the model (e.g. a Catalyst 3850 reports no model number there); the
  probe now reads `entPhysicalModelName`. Vendor-neutral. Existing devices need a
  one-time re-probe/backfill to populate the stored model.
- **Per-controller poll interval honored exactly.** Added a small grace tolerance
  to the interval check so a controller whose interval equals the scheduler tick
  period syncs every tick rather than every other tick.

## [2.0.4]

### Added
- **UniFi official API-key authentication** (Network Application 10.1.84+ /
  UniFi OS). The connector now prefers a stateless `X-API-KEY` — no stored
  controller admin password, no session management — with username/password as
  the fallback for older controllers. When using credentials, a dedicated local
  read-only account is recommended; generate API keys on the controller under
  Settings → Integrations. Verified against UniFi OS Server.
- **Config version deletion** — archived config versions can be deleted from the
  version history (admin-only, with confirmation). Deletion removes the version
  from the application (no longer viewable, diffable, or restorable); the
  underlying git commit remains in repo history, since rewriting history would
  invalidate every later version. Note: a backup that captured a secret
  requiring true on-disk purging still needs manual repo surgery.
- **Config retention cap** — optional global "keep last N versions per device"
  setting (default: keep all). Oldest versions are pruned automatically after
  each successful backup.

### Fixed
- The red alert badge on the sidebar bell was hardcoded always-on. It now
  reflects live state: shown only when unacknowledged open alerts exist, with a
  count tooltip, refreshing every 60s and on view changes.

## [2.0.3]

### Security
- Updated dependencies to clear reported vulnerabilities:
  - **GitPython 3.1.43 → 3.1.50** — patches command-injection / path-traversal /
    config-section-injection RCE advisories. (SwitchDex only uses local repo
    operations — diff/commit — not the vulnerable remote-clone or config_writer
    APIs, so exposure was limited, but the bump removes the risk entirely.)
  - **python-multipart 0.0.20 → 0.0.26** — patches the arbitrary-file-write
    (requires non-default upload config SwitchDex doesn't use) and multipart DoS
    advisories. Used on the login form parse path.
  - **PyJWT 2.10.1 → 2.12.0** — rejects tokens with unknown `crit` header
    extensions per RFC 7515.
  - **requests 2.32.3 → 2.32.4** — fixes the `.netrc` credential-leak via crafted
    URLs.
  - **vite 5.4.2 → 5.4.20** (dev/build-only; not shipped in the deployed
    container) — clears the optimized-deps path-traversal advisory.

## [2.0.2]

### Fixed
- **Config diff/compare always failed with a 422 "unable to parse string as an
  integer."** The `/configs/diff` route was declared after `/configs/{version_id}`,
  so FastAPI matched "diff" as a version id and tried to parse it as an int. Moved
  the literal route ahead of the parameterized one.
- Frontend now surfaces backend error detail correctly instead of rendering
  `[object Object]` when the detail is a validation array/object.

### Added
- **Enable/disable toggle for automations** directly on the automations list — an
  automation can be turned off without deleting it (preserving its config,
  guardrails, and run history).
- **"Refresh now" button** on the empty interface faceplate state — triggers an
  on-demand SNMP interface enumeration instead of waiting for the next poll.
- **"Edit configuration" from the Interfaces tab** — the per-interface throughput
  view now links into the interface editor, giving a second path to interface
  config if the faceplate view is unavailable. The editor also no longer crashes
  when an interface has no enumerated config yet (shows guidance to refresh first).

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
