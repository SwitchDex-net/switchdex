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


async def poll_controllers():
    """Refresh read-only telemetry from UniFi/Omada controllers."""
    async with SessionLocal() as s:
        cids = (await s.execute(
            select(Controller.id).where(Controller.enabled == True))).scalars().all()  # noqa: E712
    for cid in cids:
        res = await sync_one(cid)
        log.info("controller %s sync: %s", cid, "ok" if res.get("ok") else res.get("error"))


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
    # daily telemetry maintenance: downsample raw -> hourly, prune old data
    sched.add_job(tel.maintain, CronTrigger(hour=3, minute=30))
    sched.start()
    log.info("scheduler started — daily backup %02d:%02d, controller poll 5m, alert eval 60s, telemetry %ds",
             settings.backup_hour, settings.backup_minute, settings.metrics_interval)
    # run forever
    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
