"""
Alert engine.

Each evaluation cycle:
  1. gather current device state
  2. for every enabled rule, compute which devices currently violate it
  3. debounce: a violation must persist `duration` seconds before it fires
  4. open new alerts (dedup by rule+device), dispatch notifications
  5. auto-resolve alerts whose condition is no longer true (if rule.auto_resolve)

Preset rules map to built-in conditions; custom rules use metric/operator/threshold.
Duration state is kept in-memory (`_pending`) keyed by dedup key — fine for a
single scheduler process, which is how the appliance runs it.
"""
import json
import datetime as dt
import logging

from sqlalchemy import select, func

from .db import SessionLocal, Device, AlertRule, Alert, NotifyChannel, MetricSample
from . import notify

log = logging.getLogger("alerts")

# dedup_key -> first time the condition was observed true (for duration debounce)
_pending: dict[str, dt.datetime] = {}


def _dedup(rule_id, device_id, suffix=""):
    return f"r{rule_id}:d{device_id}:{suffix}"


def _cmp(value, op, threshold):
    try:
        v = float(value)
    except (TypeError, ValueError):
        return False
    return {">": v > threshold, "<": v < threshold, ">=": v >= threshold,
            "<=": v <= threshold, "==": v == threshold, "!=": v != threshold}.get(op, False)


def _violations(rule, devices, metrics):
    """Return list of (device, detail) currently violating this rule.
    `metrics` maps device_id -> {"cpu": float, "mem": float} from the latest
    samples, so threshold rules evaluate against live telemetry, not the stale
    device row (CPU/mem are not stored on the device record)."""
    out = []
    scope_ids = set()
    if rule.scope:
        scope_ids = {int(x) for x in rule.scope.split(",") if x.strip().isdigit()}

    for d in devices:
        if scope_ids and d.id not in scope_ids:
            continue
        m = metrics.get(d.id, {})

        if rule.preset == "device_down":
            if d.status == "down":
                out.append((d, f"{d.name} ({d.ip}) is unreachable"))
        elif rule.preset == "cpu_high":
            cpu = m.get("cpu")
            if d.status != "down" and cpu is not None and _cmp(cpu, ">", rule.threshold or 85):
                out.append((d, f"CPU {round(cpu)}% exceeds {rule.threshold or 85}%"))
        elif rule.preset == "mem_high":
            mem = m.get("mem")
            if d.status != "down" and mem is not None and _cmp(mem, ">", rule.threshold or 85):
                out.append((d, f"Memory {round(mem)}% exceeds {rule.threshold or 85}%"))
        elif rule.preset == "backup_failed":
            # surfaced via configstore; placeholder hook for real wiring
            pass
        elif rule.preset == "custom":
            cve_metrics = ("cve_critical", "cve_high", "cve_total")
            if rule.metric in ("cpu", "mem", *cve_metrics):
                val = m.get(rule.metric, 0 if rule.metric in cve_metrics else None)
            else:
                val = getattr(d, rule.metric, None)
            if val is not None and _cmp(val, rule.operator, rule.threshold):
                out.append((d, f"{rule.metric} {val} {rule.operator} {rule.threshold}"))
    return out


async def _latest_metrics(session):
    """device_id -> {cpu, mem, cve_critical, cve_high, cve_total} for rule eval."""
    out = {}
    for metric in ("cpu", "mem"):
        # latest ts per device for this metric
        sub = (select(MetricSample.device_id, func.max(MetricSample.ts).label("mx"))
               .where(MetricSample.metric == metric)
               .group_by(MetricSample.device_id)).subquery()
        rows = (await session.execute(
            select(MetricSample.device_id, MetricSample.value)
            .join(sub, (MetricSample.device_id == sub.c.device_id) & (MetricSample.ts == sub.c.mx))
            .where(MetricSample.metric == metric)
        )).all()
        for did, val in rows:
            out.setdefault(did, {})[metric] = val
    # CVE finding counts per device, so custom rules can target cve_critical etc.
    try:
        from .db import DeviceCve
        rows = (await session.execute(
            select(DeviceCve.device_id, DeviceCve.severity, func.count())
            .group_by(DeviceCve.device_id, DeviceCve.severity)
        )).all()
        for did, sev, n in rows:
            d = out.setdefault(did, {})
            d["cve_total"] = d.get("cve_total", 0) + n
            if sev == "CRITICAL":
                d["cve_critical"] = d.get("cve_critical", 0) + n
            elif sev == "HIGH":
                d["cve_high"] = d.get("cve_high", 0) + n
    except Exception:  # noqa: BLE001
        pass
    return out


async def evaluate():
    """One evaluation pass over all enabled rules."""
    async with SessionLocal() as s:
        rules = (await s.execute(select(AlertRule).where(AlertRule.enabled == True))).scalars().all()  # noqa: E712
        devices = (await s.execute(select(Device))).scalars().all()
        dev_by_id = {d.id: d for d in devices}
        metrics = await _latest_metrics(s)

        now = dt.datetime.utcnow()
        currently_true = set()

        for rule in rules:
            for dev, detail in _violations(rule, devices, metrics):
                key = _dedup(rule.id, dev.id)
                currently_true.add(key)

                # debounce by duration
                first = _pending.get(key)
                if first is None:
                    _pending[key] = now
                    first = now
                if (now - first).total_seconds() < (rule.duration or 0):
                    continue  # not held long enough yet

                # already open?
                existing = (await s.execute(
                    select(Alert).where(Alert.dedup_key == key, Alert.state != "resolved")
                )).scalar_one_or_none()
                if existing:
                    continue

                alert = Alert(rule_id=rule.id, device_id=dev.id, dedup_key=key,
                              severity=rule.severity, title=f"{rule.name}: {dev.name}",
                              detail=detail, state="open", opened_at=now)
                s.add(alert)
                await s.commit()
                log.info("ALERT opened: %s", alert.title)

                # ── feed the automation engine ──
                # Notifications are no longer sent directly from the alert engine;
                # an automation with trigger "an alert fires" (or a specific event
                # below) is now the notification path, so routing lives with the
                # automation that picks the destination channels.
                try:
                    from . import automations as autoeng
                    preset = rule.preset or ""
                    ctx = {"device_id": dev.id, "device_name": dev.name,
                           "title": alert.title, "severity": rule.severity,
                           "rule_id": rule.id, "rule_name": rule.name}
                    # always emit the generic alert_fired event
                    await autoeng.on_event("alert_fired", ctx)
                    # plus specific events automations can target directly
                    if preset == "device_down":
                        await autoeng.on_event("device_down", ctx)
                    elif preset in ("cpu_high", "mem_high"):
                        metric = "cpu" if preset == "cpu_high" else "mem"
                        m = metrics.get(dev.id, {})
                        await autoeng.on_event("metric_threshold",
                                               {**ctx, "metric": metric, "value": m.get(metric)})
                except Exception as e:  # noqa: BLE001
                    log.warning("automation event dispatch failed: %s", e)

        # auto-resolve: open alerts whose condition is no longer true
        open_alerts = (await s.execute(
            select(Alert).where(Alert.state != "resolved"))).scalars().all()
        for a in open_alerts:
            if a.dedup_key in currently_true:
                continue
            _pending.pop(a.dedup_key, None)
            rule = next((r for r in rules if r.id == a.rule_id), None)
            if rule is None or rule.auto_resolve:
                a.state = "resolved"; a.resolved_at = now; a.resolved_by = "auto"
                log.info("ALERT auto-resolved: %s", a.title)
        await s.commit()


DEFAULT_RULES = [
    dict(name="Device unreachable", preset="device_down", severity="critical", duration=120, auto_resolve=True),
    dict(name="High CPU", preset="cpu_high", threshold=85, severity="warning", duration=300, auto_resolve=True),
    dict(name="High memory", preset="mem_high", threshold=85, severity="warning", duration=300, auto_resolve=True),
    dict(name="Config changed", preset="config_changed", severity="info", duration=0, auto_resolve=False),
]


async def seed_default_rules():
    async with SessionLocal() as s:
        n = (await s.execute(select(AlertRule))).scalars().first()
        if n is None:
            for r in DEFAULT_RULES:
                s.add(AlertRule(**r))
            await s.commit()


async def raise_config_changed(device_id: int, device_name: str, detail: str):
    """Called by the backup engine when change detection fires, so config
    changes become first-class alerts/notifications."""
    async with SessionLocal() as s:
        rule = (await s.execute(
            select(AlertRule).where(AlertRule.preset == "config_changed", AlertRule.enabled == True)  # noqa: E712
        )).scalar_one_or_none()
        if not rule:
            return
        now = dt.datetime.utcnow()
        key = _dedup(rule.id, device_id, now.strftime("%Y%m%d%H%M%S"))
        alert = Alert(rule_id=rule.id, device_id=device_id, dedup_key=key,
                      severity=rule.severity, title=f"Config changed: {device_name}",
                      detail=detail, state="open", opened_at=now)
        s.add(alert)
        await s.commit()
        # notifications now flow via automations ("config drift" trigger)
        try:
            from . import automations as autoeng
            await autoeng.on_event("config_drift",
                                   {"device_id": device_id, "device_name": device_name})
        except Exception:  # noqa: BLE001
            pass
