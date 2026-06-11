"""Standalone scheduler process. Runs the daily fleet backup and any
change-detection alerts. Runs as its own container so the API stays light."""
import asyncio
import logging
import datetime as dt

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from .config import settings
from .db import init_db, SessionLocal, Device, Controller
from . import configstore as store
from .integrations import sync_one
from . import alerts as alert_engine
from . import automations as autoeng
from . import telemetry as tel
from . import cve as scanner

logging.basicConfig(level=logging.INFO, format="%(asctime)s [scheduler] %(message)s")
log = logging.getLogger("scheduler")


async def backup_fleet():
    import datetime as _dt
    now = _dt.datetime.utcnow()
    async with SessionLocal() as s:
        # only manageable devices with archiving enabled, whose interval has elapsed
        devs = (await s.execute(
            select(Device).where(Device.capability == "manage",
                                 Device.backup_enabled == True)  # noqa: E712
        )).scalars().all()
        due = []
        for d in devs:
            interval = max(1, d.backup_interval_hours or 24)
            if d.last_backup_at is None or (now - d.last_backup_at).total_seconds() >= interval * 3600:
                due.append(d.id)

    sem = asyncio.Semaphore(settings.backup_concurrency)
    changed = 0

    async def one(device_id):
        nonlocal changed
        async with sem:
            res = await store.backup_device(device_id, trigger="scheduled", user="scheduler")
            if res.get("changed"):
                changed += 1
                log.info("device %s config changed -> new version %s", device_id, res.get("hash"))
            # stamp last_backup_at regardless of changed, so the interval advances
            async with SessionLocal() as s2:
                d2 = await s2.get(Device, device_id)
                if d2:
                    d2.last_backup_at = _dt.datetime.utcnow()
                    await s2.commit()

    await asyncio.gather(*(one(i) for i in due))
    log.info("fleet backup complete: %d due of %d enabled, %d changed (concurrency=%d)",
             len(due), len(devs), changed, settings.backup_concurrency)


async def discover_neighbors():
    """Discover LLDP/CDP neighbors for SNMP-managed devices and persist them as
    neighbors_json, so the topology map can draw real links. Topology changes
    slowly, so this runs infrequently."""
    import json as _json
    from . import devices as drv
    async with SessionLocal() as s:
        devs = (await s.execute(
            select(Device).where(Device.capability == "manage"))).scalars().all()
        rows = [(d.id, d.ip, d.snmp_community) for d in devs]
    total = 0
    for did, ip, community in rows:
        community = community or settings.default_snmp_community
        if not (ip and community):
            continue
        try:
            neighbors = await asyncio.to_thread(drv.lldp_neighbors, ip, community)
        except Exception as e:  # noqa: BLE001
            log.info("neighbor discovery failed for %s: %s", ip, e)
            continue
        async with SessionLocal() as s:
            d = await s.get(Device, did)
            if d:
                d.neighbors_json = _json.dumps(neighbors)
                await s.commit()
        total += len(neighbors)
        log.info("device %s (%s): %d neighbors", did, ip, len(neighbors))
    log.info("neighbor discovery complete: %d devices, %d total neighbors", len(rows), total)


async def poll_controllers():
    """Refresh each controller's device list + read-only state, honoring that
    controller's own poll_interval (seconds). This job ticks every minute but
    only syncs a controller once its interval has elapsed since last_poll — so
    a user can dial a rate-limited cloud controller down (e.g. 900s) or a local
    one up (e.g. 60s) per integration."""
    now = dt.datetime.utcnow()
    async with SessionLocal() as s:
        ctrls = (await s.execute(
            select(Controller).where(Controller.enabled == True))).scalars().all()  # noqa: E712
    due = []
    for c in ctrls:
        interval = max(30, c.poll_interval or 300)   # floor of 30s to avoid hammering
        # Grace tolerance: the job ticks every 60s, and scheduler jitter makes the
        # measured elapsed land a hair under `interval` on the tick where it should
        # fire (e.g. 59.97s for a 60s interval), so a strict `>= interval` skips
        # that tick and waits a full extra period (60s set → 120s actual). Allow a
        # small tolerance so a controller whose interval == the tick period fires
        # every tick as intended. Tolerance stays well under the tick period, so a
        # controller can never double-fire within one tick.
        TICK_GRACE = 5  # seconds
        if c.last_poll is None or (now - c.last_poll).total_seconds() >= (interval - TICK_GRACE):
            due.append(c.id)
    for cid in due:
        res = await sync_one(cid)
        log.info("controller %s sync: %s", cid, "ok" if res.get("ok") else res.get("error"))


async def sample_controller_metrics():
    """Sample controller-managed device metrics (AP/switch CPU/mem/uptime) on a
    faster cadence. Safe to poll frequently against a self-hosted controller."""
    async with SessionLocal() as s:
        any_ctrl = (await s.execute(
            select(Controller.id).where(Controller.enabled == True))).scalars().first()  # noqa: E712
    if any_ctrl:
        n = await tel.collect_once(scope="controller")
        log.info("controller-device telemetry sampled (%d rows)", n)


async def main():
    await init_db()
    await alert_engine.seed_default_rules()
    sched = AsyncIOScheduler()
    sched.add_job(backup_fleet, "interval", hours=1)
    # tick every minute; poll_controllers internally honors each controller's
    # own poll_interval (gated on last_poll), so the effective cadence is per-integration
    sched.add_job(poll_controllers, "interval", minutes=1)
    # sample controller-managed device metrics every 60s (self-hosted controller,
    # no cloud API quota — responsive AP/switch telemetry)
    sched.add_job(sample_controller_metrics, "interval", seconds=60)
    # evaluate alert rules every 60 seconds
    sched.add_job(alert_engine.evaluate, "interval", seconds=60)
    async def sample_open_metrics():
        try:
            n = await tel.collect_once(scope="open")
            log.info("open-device telemetry sampled (%d rows)", n)
        except Exception as e:  # noqa: BLE001
            log.error("open telemetry sample failed: %s", e)
    # sample open-protocol (SNMP) device telemetry every 60s. We intentionally do
    # NOT use settings.metrics_interval here (it can be set high, e.g. 300s, which
    # makes throughput graphs too coarse). The interface-counter walk is heavy, so
    # give the job overlap tolerance and coalesce missed runs.
    sched.add_job(sample_open_metrics, "interval", seconds=60,
                  max_instances=2, coalesce=True, misfire_grace_time=30)

    sched.add_job(discover_neighbors, "interval", minutes=15)
    # daily telemetry maintenance: downsample raw -> hourly, prune old data
    sched.add_job(tel.maintain, CronTrigger(hour=3, minute=30))

    async def cve_nightly_scan():
        try:
            scan = await scanner.scan_fleet()
            log.info("nightly CVE scan: %s", scan)
        except Exception as e:  # noqa: BLE001
            log.error("CVE scan failed: %s", e)
    sched.add_job(cve_nightly_scan,
                  CronTrigger(hour=0, minute=0, timezone="America/Chicago"))

    # tick scheduled automations every minute (fires cron-matched automations)
    async def automation_tick():
        try:
            await autoeng.tick_scheduled()
            await autoeng.tick_metric_thresholds()
        except Exception as e:  # noqa: BLE001
            log.error("automation tick failed: %s", e)
    sched.add_job(automation_tick, "interval", minutes=1)

    sched.start()
    log.info("scheduler started — daily backup %02d:%02d, controller poll 5m, alert eval 60s, telemetry 60s",
             settings.backup_hour, settings.backup_minute)
    # kick off an initial neighbor discovery so the topology map populates
    # without waiting for the first 15-minute interval
    asyncio.create_task(discover_neighbors())
    # run forever
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
