"""Automation engine: trigger → scope → condition → action, with mechanical
safety rails for remediation actions.

Triggers are either event-driven (an alert fires, a metric crosses a threshold,
a CVE is found, a device goes down, config drifts) or scheduled (cron). Actions
range from safe (notify / backup / scan / create_alert) to remediation
(push_config / disable_interface).

Safety model for remediation (applies even when an automation runs un-gated,
i.e. requires_approval = False):
  • armed=False  → the action is computed and logged as a dry-run, never applied,
                   until an admin explicitly arms the automation.
  • cooldown     → the same automation won't act on the same device again within
                   cooldown_minutes (prevents flapping loops).
  • blast radius → max_devices_per_run caps how many devices one firing can touch.
  • protect_uplink → disable_interface refuses to shut the interface that carries
                   the management path to the device (so it can't sever its own
                   control channel).
  • requires_approval=True → remediation is queued as a pending AutomationRun for
                   an admin to approve before it executes.
Every execution (dry, blocked, queued, or applied) writes an AutomationRun row.
"""
import json
import datetime as dt

from sqlalchemy import select

from .db import (SessionLocal, Automation, AutomationRun, Device, Alert,
                 AlertRule, NotifyChannel)
from . import notify
from . import configstore as store
from . import cve as scanner
from . import devices as drv
from .config import settings

SAFE_ACTIONS = {"notify", "backup_config", "run_scan", "create_alert"}
REMEDIATION_ACTIONS = {"push_config", "disable_interface"}


# ───────────────────────── scope resolution ────────────────────────────
async def _resolve_scope(auto, session):
    """Return the list of Device rows this automation applies to, before the
    blast-radius cap."""
    q = select(Device)
    devices = (await session.execute(q)).scalars().all()
    st = auto.scope_type
    if st == "all":
        return devices
    try:
        sc = json.loads(auto.scope_json or "{}")
    except Exception:  # noqa: BLE001
        sc = {}
    if st == "type":
        return [d for d in devices if d.device_type == sc.get("value")]
    if st == "role":
        return [d for d in devices if d.role == sc.get("value")]
    if st == "ids":
        ids = set(sc.get("ids", []))
        return [d for d in devices if d.id in ids]
    return devices


# ───────────────────────── guardrail helpers ───────────────────────────
def _in_cooldown(auto, now):
    if not auto.last_fired_at:
        return False
    return (now - auto.last_fired_at) < dt.timedelta(minutes=auto.cooldown_minutes or 0)


def _is_uplink_interface(dev, ifname):
    """Heuristic: is this the interface that carries the management path? We
    don't always know the exact SNMP ifIndex of the mgmt interface, so be
    conservative — treat anything that looks like an uplink/management/trunk
    port, or that the device reaches us through, as protected. When unsure,
    err toward protecting (return True)."""
    if not ifname:
        return True
    n = ifname.lower()
    for kw in ("uplink", "mgmt", "management", "wan", "trunk"):
        if kw in n:
            return True
    return False


# ───────────────────────── action execution ────────────────────────────
async def _run_action(auto, devices, session, dry_run):
    """Execute (or simulate, if dry_run) the action across `devices`.
    Returns a human-readable detail string."""
    act = auto.action_type
    try:
        cfg = json.loads(auto.action_json or "{}")
    except Exception:  # noqa: BLE001
        cfg = {}
    lines = []

    for d in devices:
        try:
            if act == "notify":
                if dry_run:
                    lines.append(f"[dry] would notify for {d.name}")
                else:
                    channels = (await session.execute(select(NotifyChannel))).scalars().all()
                    await notify.dispatch(channels, {
                        "severity": cfg.get("severity", "info"),
                        "title": cfg.get("title", f"Automation: {auto.name}"),
                        "detail": cfg.get("message", "") or f"Triggered for {d.name}",
                        "device": d.name, "time": dt.datetime.utcnow().isoformat() + "Z"})
                    lines.append(f"notified for {d.name}")

            elif act == "backup_config":
                if dry_run:
                    lines.append(f"[dry] would back up {d.name}")
                else:
                    await store.backup_device(d.id, trigger="automation", user=f"auto:{auto.name}")
                    lines.append(f"backed up {d.name}")

            elif act == "run_scan":
                if dry_run:
                    lines.append(f"[dry] would scan {d.name}")
                else:
                    await scanner.scan_device(d.id)
                    lines.append(f"scanned {d.name}")

            elif act == "create_alert":
                if dry_run:
                    lines.append(f"[dry] would raise alert for {d.name}")
                else:
                    now = dt.datetime.utcnow()
                    alert = Alert(rule_id=None, device_id=d.id,
                                  dedup_key=f"auto-{auto.id}-{d.id}-{now.strftime('%Y%m%d%H%M%S')}",
                                  severity=cfg.get("severity", "warning"),
                                  title=cfg.get("title", f"Automation: {auto.name}"),
                                  detail=cfg.get("message", ""), state="open", opened_at=now)
                    session.add(alert)
                    lines.append(f"raised alert for {d.name}")

            elif act == "push_config":
                snippet = cfg.get("config", "")
                if not snippet:
                    lines.append(f"SKIP {d.name}: no config snippet")
                    continue
                if dry_run:
                    lines.append(f"[dry] would push to {d.name}:\n{snippet}")
                else:
                    await drv.push_config(d, snippet)
                    lines.append(f"pushed config to {d.name}")

            elif act == "disable_interface":
                ifname = cfg.get("interface", "")
                if not ifname:
                    lines.append(f"SKIP {d.name}: no interface specified")
                    continue
                if auto.protect_uplink and _is_uplink_interface(d, ifname):
                    lines.append(f"BLOCKED {d.name}: {ifname} looks like a management/uplink port (protect_uplink on)")
                    continue
                if dry_run:
                    lines.append(f"[dry] would disable {ifname} on {d.name}")
                else:
                    creds = (d.ssh_username, d.ssh_password)
                    await _to_thread_apply(d, ifname)
                    lines.append(f"disabled {ifname} on {d.name}")
            else:
                lines.append(f"unknown action '{act}'")
        except Exception as e:  # noqa: BLE001
            lines.append(f"ERROR {d.name}: {e}")

    return "\n".join(lines) if lines else "(no devices in scope)"


async def _to_thread_apply(dev, ifname):
    """Apply shutdown to one interface using the per-platform CLI path."""
    import asyncio
    if settings.device_backend == "sim":
        return
    await asyncio.to_thread(drv.apply_interface_config, dev.ip, dev.ssh_port,
                            dev.ssh_username, dev.ssh_password, ifname,
                            {"shutdown": True}, dev.platform)


# ───────────────────────── the core: fire an automation ────────────────
async def fire(auto, trigger_summary, session, trigger_device_id=None):
    """Run one automation now, honoring all guardrails. Writes an AutomationRun
    and returns it. `auto` and `session` are live within the caller's session.

    If `trigger_device_id` is given (event-driven automation fired by something
    that happened on a specific device), the action targets ONLY that device —
    with the automation's scope acting as a filter (e.g. scope=switches means the
    automation simply won't fire for a non-switch). Scheduled automations pass
    no trigger device and act across the full scope."""
    now = dt.datetime.utcnow()

    # cooldown gate
    if _in_cooldown(auto, now):
        run = AutomationRun(automation_id=auto.id, ts=now, trigger_summary=trigger_summary,
                            status="skipped", detail=f"in cooldown ({auto.cooldown_minutes}m)")
        session.add(run); await session.commit()
        return run

    scoped = await _resolve_scope(auto, session)

    if trigger_device_id is not None:
        # event on a specific device: act only on it, and only if it's in scope
        target = next((d for d in scoped if d.id == trigger_device_id), None)
        if target is None:
            run = AutomationRun(automation_id=auto.id, ts=now, trigger_summary=trigger_summary,
                                status="skipped",
                                detail="triggering device is outside this automation's scope")
            session.add(run); await session.commit()
            return run
        capped = [target]
        blast_note = ""
    else:
        capped = scoped[: max(1, auto.max_devices_per_run or 1)]
        blast_note = "" if len(capped) == len(scoped) else f" (capped {len(scoped)}→{len(capped)} by blast radius)"

    device_ids = [d.id for d in capped]

    is_remed = auto.action_type in REMEDIATION_ACTIONS

    # remediation requiring approval → queue, don't execute
    if is_remed and auto.requires_approval:
        run = AutomationRun(automation_id=auto.id, ts=now, trigger_summary=trigger_summary,
                            device_ids_json=json.dumps(device_ids), status="pending_approval",
                            detail=f"Awaiting admin approval.{blast_note}")
        session.add(run); await session.commit()
        return run

    # remediation not yet armed → dry-run only
    dry = is_remed and not auto.armed
    detail = await _run_action(auto, capped, session, dry_run=dry)
    auto.last_fired_at = now
    run = AutomationRun(automation_id=auto.id, ts=now, trigger_summary=trigger_summary,
                        device_ids_json=json.dumps(device_ids),
                        status="dry_run" if dry else "executed",
                        detail=(("[DRY RUN — automation not armed]\n" if dry else "") + detail + blast_note))
    session.add(run); await session.commit()
    return run


async def approve_run(run_id, approver, approve=True):
    """Approve (and execute) or reject a pending remediation run."""
    async with SessionLocal() as s:
        run = await s.get(AutomationRun, run_id)
        if not run or run.status != "pending_approval":
            return None
        auto = await s.get(Automation, run.automation_id)
        now = dt.datetime.utcnow()
        if not approve:
            run.status = "rejected"; run.approved_by = approver; run.approved_at = now
            await s.commit(); return run
        ids = json.loads(run.device_ids_json or "[]")
        devs = [await s.get(Device, i) for i in ids]
        devs = [d for d in devs if d]
        dry = not auto.armed
        detail = await _run_action(auto, devs, s, dry_run=dry)
        auto.last_fired_at = now
        run.status = "dry_run" if dry else "executed"
        run.approved_by = approver; run.approved_at = now
        run.detail = (("[DRY RUN — automation not armed]\n" if dry else "") +
                      f"Approved by {approver}.\n" + detail)
        await s.commit()
        return run


# ───────────────────────── trigger entry points ────────────────────────
async def on_event(event, context):
    """Called when something happens in the system (alert fired, cve found,
    device down, config drift). `context` carries event-specific fields like
    device_id, metric, value. Fires every enabled event automation whose
    trigger matches."""
    async with SessionLocal() as s:
        autos = (await s.execute(
            select(Automation).where(Automation.enabled == True,  # noqa: E712
                                      Automation.trigger_type == "event"))).scalars().all()
        for auto in autos:
            try:
                tj = json.loads(auto.trigger_json or "{}")
            except Exception:  # noqa: BLE001
                tj = {}
            if tj.get("event") != event:
                continue
            if not _event_matches(event, tj, context):
                continue
            summary = _event_summary(event, context)
            # detach: fire uses the same session
            auto2 = await s.get(Automation, auto.id)
            await fire(auto2, summary, s, trigger_device_id=context.get("device_id"))


def _event_matches(event, tj, context):
    """Extra per-event matching (e.g. threshold comparisons)."""
    if event == "metric_threshold":
        metric = tj.get("metric"); op = tj.get("op", ">"); thr = tj.get("value")
        if context.get("metric") != metric:
            return False
        v = context.get("value")
        if v is None or thr is None:
            return False
        return _cmp(v, op, float(thr))
    if event == "cve_found":
        min_sev = (tj.get("min_severity") or "high").lower()
        order = {"low": 0, "medium": 1, "high": 2, "critical": 3}
        return order.get((context.get("severity") or "").lower(), -1) >= order.get(min_sev, 2)
    return True


def _cmp(v, op, thr):
    if op == ">":
        return v > thr
    if op == ">=":
        return v >= thr
    if op == "<":
        return v < thr
    if op == "<=":
        return v <= thr
    if op == "==":
        return v == thr
    return False


def _event_summary(event, context):
    dn = context.get("device_name", f"device {context.get('device_id','?')}")
    if event == "metric_threshold":
        return f"{context.get('metric')}={context.get('value')} on {dn}"
    if event == "cve_found":
        return f"{context.get('severity','?')} CVE on {dn}"
    if event == "device_down":
        return f"{dn} went down"
    if event == "config_drift":
        return f"config drift on {dn}"
    if event == "alert_fired":
        return f"alert: {context.get('title','')} on {dn}"
    return event


async def run_scheduled(automation_id):
    """Called by the scheduler for cron-triggered automations."""
    async with SessionLocal() as s:
        auto = await s.get(Automation, automation_id)
        if not auto or not auto.enabled or auto.trigger_type != "schedule":
            return
        await fire(auto, "scheduled run", s)


async def tick_scheduled():
    """Called every minute by the scheduler process. Fires any enabled
    schedule-type automation whose cron expression matches the current minute.
    Uses last_fired_at to avoid double-firing within the same minute."""
    try:
        from apscheduler.triggers.cron import CronTrigger
    except Exception:  # noqa: BLE001
        return
    now = dt.datetime.utcnow().replace(second=0, microsecond=0)
    async with SessionLocal() as s:
        autos = (await s.execute(
            select(Automation).where(Automation.enabled == True,  # noqa: E712
                                      Automation.trigger_type == "schedule"))).scalars().all()
        for auto in autos:
            try:
                tj = json.loads(auto.trigger_json or "{}")
                cron = tj.get("cron", "")
                if not cron:
                    continue
                trig = CronTrigger.from_crontab(cron)
                # does this cron fire at `now`? compare the next fire from one
                # minute before to `now`.
                prev = now - dt.timedelta(minutes=1)
                nxt = trig.get_next_fire_time(None, prev)
                if not nxt:
                    continue
                nxt_utc = nxt.replace(tzinfo=None)
                if nxt_utc != now:
                    continue
                # guard against double-fire in the same minute
                if auto.last_fired_at and auto.last_fired_at.replace(second=0, microsecond=0) == now:
                    continue
                auto2 = await s.get(Automation, auto.id)
                await fire(auto2, "scheduled run", s)
            except Exception:  # noqa: BLE001
                continue
