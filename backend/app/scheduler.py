"""Standalone scheduler process. Runs the daily fleet backup and any
change-detection alerts. Runs as its own container so the API stays light."""
import asyncio
import logging

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from sqlalchemy import select

from .config import settings
from .db import init_db, SessionLocal, Device, Controller
from . import configstore as store
from .integrations import sync_one
from . import alerts as alert_engine
from . import telemetry as tel

logging.basicConfig(level=logging.INFO, format="%(asctime)s [scheduler] %(message)s")
log = logging.getLogger("scheduler")


async def backup_fleet():
    async with SessionLocal() as s:
        # only manageable (open-protocol) devices get config backups
        ids = (await s.execute(
            select(Device.id).where(Device.capability == "manage")
        )).scalars().all()

    sem = asyncio.Semaphore(settings.backup_concurrency)
    changed = 0

    async def one(device_id):
        nonlocal changed
        async with sem:
            res = await store.backup_device(device_id, trigger="scheduled", user="scheduler")
            if res.get("changed"):
                changed += 1
                log.info("device %s config changed -> new version %s", device_id, res.get("hash"))

    await asyncio.gather(*(one(i) for i in ids))
    log.info("fleet backup complete: %d devices, %d changed (concurrency=%d)",
             len(ids), changed, settings.backup_concurrency)


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
    """Refresh read-only telemetry from UniFi/Omada controllers."""
    async with SessionLocal() as s:
        cids = (await s.execute(
            select(Controller.id).where(Controller.enabled == True))).scalars().all()  # noqa: E712
    for cid in cids:
        res = await sync_one(cid)
        log.info("controller %s sync: %s", cid, "ok" if res.get("ok") else res.get("error"))
    # sample controller-managed devices' metrics at this (slower) cadence so we
    # don't exceed controller API rate limits with the fast SNMP interval
    if cids:
        n = await tel.collect_once(scope="controller")
        log.info("controller-device telemetry sampled (%d rows)", n)


async def main():
    await init_db()
    await alert_engine.seed_default_rules()
    sched = AsyncIOScheduler()
    sched.add_job(backup_fleet, CronTrigger(hour=settings.backup_hour, minute=settings.backup_minute))
    # poll closed-ecosystem controllers every 5 minutes for fresh read-only telemetry
    sched.add_job(poll_controllers, "interval", minutes=5)
    # evaluate alert rules every 60 seconds
    sched.add_job(alert_engine.evaluate, "interval", seconds=60)
    # sample device telemetry on the configured interval
    sched.add_job(tel.collect_once, "interval", seconds=settings.metrics_interval)

    sched.add_job(discover_neighbors, "interval", minutes=15)
    # daily telemetry maintenance: downsample raw -> hourly, prune old data
    sched.add_job(tel.maintain, CronTrigger(hour=3, minute=30))
    sched.start()
    log.info("scheduler started — daily backup %02d:%02d, controller poll 5m, alert eval 60s, telemetry %ds",
             settings.backup_hour, settings.backup_minute, settings.metrics_interval)
    # kick off an initial neighbor discovery so the topology map populates
    # without waiting for the first 15-minute interval
    asyncio.create_task(discover_neighbors())
    # run forever
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
