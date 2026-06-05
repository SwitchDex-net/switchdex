"""Security (vulnerability scanning) API — exposes the NVD-backed CVE matching."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import json

from . import cve as scanner
from .auth import get_current_user, require_admin
from .db import SessionLocal, Device, Cve
from sqlalchemy import select, func

router = APIRouter(prefix="/api/security", tags=["security"])


@router.get("/summary")
async def summary(_: dict = Depends(get_current_user)):
    """Per-device vulnerability counts + DB status for the Security view."""
    devices = await scanner.fleet_summary()
    # controller software findings (cached on the Controller row)
    controllers = []
    async with SessionLocal() as s:
        from .db import Controller
        for c in (await s.execute(select(Controller))).scalars().all():
            res = {}
            if c.cve_json:
                try:
                    res = json.loads(c.cve_json)
                except Exception:  # noqa: BLE001
                    res = {}
            bysev = res.get("by_severity", {})
            controllers.append({
                "id": c.id, "name": c.name, "kind": c.kind,
                "version": c.controller_version,
                "critical": bysev.get("CRITICAL", 0), "high": bysev.get("HIGH", 0),
                "total": res.get("matched", 0), "covered": res.get("covered"),
                "scanned_at": c.cve_scanned_at.isoformat() + "Z" if c.cve_scanned_at else None,
            })
    async with SessionLocal() as s:
        cve_count = (await s.execute(select(func.count()).select_from(Cve))).scalar() or 0
        last = (await s.execute(
            select(func.max(Cve.last_modified)))).scalar()
    return {
        "devices": devices,
        "controllers": controllers,
        "cve_db": {"count": cve_count, "newest": last.isoformat() + "Z" if last else None},
        "totals": {
            "critical": sum(d["critical"] for d in devices) + sum(c["critical"] for c in controllers),
            "high": sum(d["high"] for d in devices) + sum(c["high"] for c in controllers),
            "total": sum(d["total"] for d in devices) + sum(c["total"] for c in controllers),
        },
    }


@router.get("/devices/{device_id}")
async def device_detail(device_id: int, _: dict = Depends(get_current_user)):
    return {"findings": await scanner.device_findings(device_id)}


@router.get("/controllers/{controller_id}")
async def controller_detail(controller_id: int, _: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        from .db import Controller
        c = await s.get(Controller, controller_id)
        if not c:
            raise HTTPException(404)
        res = json.loads(c.cve_json) if c.cve_json else {}
    return {"findings": res.get("findings", []), "covered": res.get("covered"),
            "version": c.controller_version}


@router.post("/controllers/{controller_id}/scan", dependencies=[Depends(require_admin)])
async def scan_controller_ep(controller_id: int):
    return await scanner.scan_controller(controller_id)


import asyncio


@router.post("/scan", dependencies=[Depends(require_admin)])
async def scan_all():
    """Kick off a fleet re-scan in the background; returns immediately.
    Poll /security/scan-status for progress/completion."""
    if scanner.scan_status()["running"]:
        return {"started": False, "already_running": True}
    asyncio.create_task(scanner.scan_fleet(background=True))
    return {"started": True}


@router.get("/scan-status")
async def scan_status_ep(_: dict = Depends(get_current_user)):
    return scanner.scan_status()


@router.post("/devices/{device_id}/scan", dependencies=[Depends(require_admin)])
async def scan_one(device_id: int):
    return await scanner.scan_device(device_id)


@router.post("/sync", dependencies=[Depends(require_admin)])
async def sync_now(full: bool = False):
    """Alias for /scan — kicks off a background fleet re-query of NVD."""
    if scanner.scan_status()["running"]:
        return {"started": False, "already_running": True}
    asyncio.create_task(scanner.scan_fleet(background=True))
    return {"started": True}


class CpeIn(BaseModel):
    cpe: str


@router.put("/devices/{device_id}/cpe", dependencies=[Depends(require_admin)])
async def set_cpe(device_id: int, body: CpeIn):
    """Override the auto-derived CPE for a device, then re-scan it."""
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        if not dev:
            raise HTTPException(404)
        dev.cpe = body.cpe.strip()
        await s.commit()
    return await scanner.scan_device(device_id)
