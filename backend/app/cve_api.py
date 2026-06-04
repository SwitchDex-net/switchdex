"""Security (vulnerability scanning) API — exposes the NVD-backed CVE matching."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import cve as scanner
from .auth_api import get_current_user, require_admin
from .db import SessionLocal, Device, Cve
from sqlalchemy import select, func

router = APIRouter(prefix="/security", tags=["security"])


@router.get("/summary")
async def summary(_: dict = Depends(get_current_user)):
    """Per-device vulnerability counts + DB status for the Security view."""
    devices = await scanner.fleet_summary()
    async with SessionLocal() as s:
        cve_count = (await s.execute(select(func.count()).select_from(Cve))).scalar() or 0
        last = (await s.execute(
            select(func.max(Cve.last_modified)))).scalar()
    return {
        "devices": devices,
        "cve_db": {"count": cve_count, "newest": last.isoformat() + "Z" if last else None},
        "totals": {
            "critical": sum(d["critical"] for d in devices),
            "high": sum(d["high"] for d in devices),
            "total": sum(d["total"] for d in devices),
        },
    }


@router.get("/devices/{device_id}")
async def device_detail(device_id: int, _: dict = Depends(get_current_user)):
    return {"findings": await scanner.device_findings(device_id)}


@router.post("/scan", dependencies=[Depends(require_admin)])
async def scan_all():
    """Re-run matching for the whole fleet against the local CVE DB (fast)."""
    return await scanner.scan_fleet()


@router.post("/devices/{device_id}/scan", dependencies=[Depends(require_admin)])
async def scan_one(device_id: int):
    return await scanner.scan_device(device_id)


@router.post("/sync", dependencies=[Depends(require_admin)])
async def sync_now(full: bool = False):
    """Pull fresh CVEs from NVD now, then re-scan the fleet. `full=true` seeds a
    larger initial window (slower)."""
    res = await scanner.sync_nvd(full=full)
    scan = await scanner.scan_fleet()
    return {"sync": res, "scan": scan}


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
