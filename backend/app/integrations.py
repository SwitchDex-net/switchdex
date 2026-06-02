"""Integrations API — manage UniFi/Omada controllers and sync their devices."""
import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete

from .db import SessionLocal, Controller, Device
from . import connectors
from .auth import get_current_user, require_admin

router = APIRouter(prefix="/api/integrations", dependencies=[Depends(get_current_user)])


class ControllerIn(BaseModel):
    name: str
    kind: str                      # unifi | omada
    base_url: str
    site: str = "default"
    verify_tls: bool = False
    username: str = ""
    password: str = ""
    api_key: str = ""
    client_id: str = ""
    client_secret: str = ""
    controller_ident: str = ""     # Omada omadacId
    poll_interval: int = 300


def _out(c: Controller) -> dict:
    return {"id": c.id, "name": c.name, "kind": c.kind, "base_url": c.base_url,
            "site": c.site, "verify_tls": c.verify_tls, "enabled": c.enabled,
            "poll_interval": c.poll_interval, "last_status": c.last_status,
            "last_poll": c.last_poll.isoformat() + "Z" if c.last_poll else None,
            "device_count": c.device_count}


@router.get("")
async def list_controllers(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(select(Controller))).scalars().all()
        return [_out(c) for c in rows]


@router.post("", dependencies=[Depends(require_admin)])
async def add_controller(body: ControllerIn):
    async with SessionLocal() as s:
        c = Controller(**body.model_dump())
        s.add(c)
        await s.commit()
        await s.refresh(c)
        cid = c.id
    await sync_one(cid)            # initial sync so devices show up immediately
    async with SessionLocal() as s:
        return _out(await s.get(Controller, cid))


@router.post("/test", dependencies=[Depends(require_admin)])
async def test_controller(body: ControllerIn):
    # build a transient (unsaved) controller object for the test
    c = Controller(**body.model_dump())
    return await connectors.test_controller(c)


@router.post("/{cid}/sync", dependencies=[Depends(require_admin)])
async def sync_controller(cid: int):
    res = await sync_one(cid)
    if not res["ok"]:
        raise HTTPException(400, res.get("error", "sync failed"))
    return res


@router.delete("/{cid}", dependencies=[Depends(require_admin)])
async def delete_controller(cid: int):
    async with SessionLocal() as s:
        c = await s.get(Controller, cid)
        if not c:
            raise HTTPException(404)
        # remove the devices this controller owned, then the controller
        await s.execute(delete(Device).where(Device.controller_id == cid))
        await s.delete(c)
        await s.commit()
    return {"ok": True}


async def sync_one(cid: int) -> dict:
    """Pull the controller's device list and upsert into inventory."""
    async with SessionLocal() as s:
        ctrl = await s.get(Controller, cid)
        if not ctrl:
            return {"ok": False, "error": "controller not found"}
    try:
        devs = await connectors.sync_controller(ctrl)
    except Exception as e:  # noqa: BLE001
        async with SessionLocal() as s:
            c = await s.get(Controller, cid)
            c.last_status = f"error: {e}"; c.last_poll = dt.datetime.utcnow()
            await s.commit()
        return {"ok": False, "error": str(e)}

    async with SessionLocal() as s:
        existing = {d.external_id: d for d in (await s.execute(
            select(Device).where(Device.controller_id == cid))).scalars().all()}
        seen = set()
        for nd in devs:
            seen.add(nd["external_id"])
            d = existing.get(nd["external_id"])
            if d:
                d.name = nd["name"]; d.ip = nd["ip"]; d.model = nd["model"]
                d.os = nd["os"]; d.status = nd["status"]
            else:
                s.add(Device(
                    name=nd["name"], hostname=nd["name"], ip=nd["ip"] or f"0.0.0.0",
                    vendor=nd["vendor"], model=nd["model"], os=nd["os"],
                    device_type=nd["device_type"], protocol=nd["source"].upper(),
                    source=nd["source"], capability=nd["capability"],
                    controller_id=cid, external_id=nd["external_id"], status=nd["status"],
                ))
        # prune devices that vanished from the controller
        for ext, d in existing.items():
            if ext not in seen:
                await s.delete(d)
        ctrl = await s.get(Controller, cid)
        ctrl.last_status = "ok"; ctrl.last_poll = dt.datetime.utcnow()
        ctrl.device_count = len(seen)
        await s.commit()
    return {"ok": True, "synced": len(devs)}


@router.get("/devices/{device_id}/metrics")
async def device_metrics(device_id: int, _: dict = Depends(get_current_user)):
    """Live read-only metrics for a controller-managed device."""
    async with SessionLocal() as s:
        d = await s.get(Device, device_id)
        if not d or not d.controller_id:
            raise HTTPException(404, "not a controller-managed device")
        ctrl = await s.get(Controller, d.controller_id)
        ext = d.external_id
    return await connectors.fetch_metrics(ctrl, ext)
