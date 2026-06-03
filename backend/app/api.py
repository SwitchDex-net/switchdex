"""REST endpoints + WebSocket SSH proxy. Matches the frontend contract."""
import asyncio
import datetime as dt

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy import select, delete as sa_delete

from .db import SessionLocal, Device, ConfigVersion
from . import devices as drv
from . import configstore as store
from .config import settings
from .auth import get_current_user, require_admin, user_from_token_str

# All HTTP routes in this router require a valid token.
router = APIRouter(prefix="/api", dependencies=[Depends(get_current_user)])
# WebSocket router authenticates via ?token= (browsers can't set WS headers).
ws_router = APIRouter(prefix="/ws")


# ───────────────────────── schemas ─────────────────────────────────────
class DeviceIn(BaseModel):
    name: str
    ip: str
    vendor: str = "Unknown"
    model: str = ""
    os: str = ""
    device_type: str = "switch"
    platform: str = "ios"
    protocol: str = "SSH"
    location: str = ""
    ssh_port: int = 22
    ssh_username: str = ""
    ssh_password: str = ""
    snmp_community: str = ""

    @property
    def hostname(self):
        return self.name


class ProbeIn(BaseModel):
    ip: str
    auth: str = "snmpv2"          # snmpv2 | snmpv3 | ssh
    community: str = "public"
    username: str = ""
    password: str = ""


# ───────────────────────── device inventory ────────────────────────────
def _dev_out(d: Device) -> dict:
    return {
        "id": d.id, "name": d.name, "hostname": d.hostname, "ip": d.ip,
        "vendor": d.vendor, "model": d.model, "os": d.os, "type": d.device_type,
        "platform": d.platform, "protocol": d.protocol, "location": d.location,
        "status": d.status, "sshPort": d.ssh_port,
        "source": d.source, "capability": d.capability,
        "controllerId": d.controller_id, "externalId": d.external_id,
    }


@router.get("/devices")
async def list_devices():
    async with SessionLocal() as s:
        rows = (await s.execute(select(Device))).scalars().all()
        return [_dev_out(d) for d in rows]


@router.post("/devices/probe")
async def probe_device(body: ProbeIn):
    """Discovery: identify a device at an IP before adding it."""
    fp = await drv.probe(body.ip, snmp_community=body.community,
                         ssh_username=body.username, ssh_password=body.password)
    return fp


@router.post("/devices")
async def add_device(body: DeviceIn):
    async with SessionLocal() as s:
        dev = Device(
            name=body.name, hostname=body.name, ip=body.ip, vendor=body.vendor,
            model=body.model, os=body.os, device_type=body.device_type,
            platform=body.platform, protocol=body.protocol, location=body.location,
            ssh_port=body.ssh_port, ssh_username=body.ssh_username,
            ssh_password=body.ssh_password, snmp_community=body.snmp_community,
        )
        s.add(dev)
        await s.commit()
        await s.refresh(dev)
        # take an initial backup so the archive has a baseline
        await store.backup_device(dev.id, trigger="manual", user="discovery")
        return _dev_out(dev)


@router.get("/devices/{device_id}/interfaces")
async def device_interfaces_live(device_id: int):
    """Enumerate the device's interfaces live (SNMP ifTable in real mode)."""
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        if not dev:
            raise HTTPException(404, "Device not found")
        if settings.device_backend == "sim":
            return {}
        community = dev.snmp_community or settings.default_snmp_community
        return await asyncio.to_thread(drv.snmp_interfaces, dev.ip, community)


@router.delete("/devices/{device_id}")
async def delete_device(device_id: int):
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        if not dev:
            raise HTTPException(404, "Device not found")
        # Remove dependent rows first. The models declare ondelete=CASCADE, but
        # an already-created database won't have that constraint, so we delete
        # explicitly to make this work on existing installs too.
        from .db import MetricSample, DeviceBaseline, Alert, ConfigVersion
        for model in (MetricSample, DeviceBaseline, Alert, ConfigVersion):
            await s.execute(sa_delete(model).where(model.device_id == device_id))
        await s.delete(dev)
        await s.commit()
    return {"ok": True}


# ───────────────────────── config archive ──────────────────────────────
@router.get("/devices/{device_id}/configs")
async def list_versions(device_id: int):
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(ConfigVersion).where(ConfigVersion.device_id == device_id)
            .order_by(ConfigVersion.ts.desc())
        )).scalars().all()
        return [{
            "id": v.id, "ts": v.ts.isoformat() + "Z", "commit": v.commit_sha,
            "hash": v.content_hash, "lines": v.lines, "bytes": v.bytes_,
            "trigger": v.trigger, "user": v.user,
        } for v in rows]


@router.get("/devices/{device_id}/configs/{version_id}")
async def get_version(device_id: int, version_id: int):
    async with SessionLocal() as s:
        v = await s.get(ConfigVersion, version_id)
        dev = await s.get(Device, device_id)
        if not v or not dev:
            raise HTTPException(404)
        rel = store._device_path(dev)
        return {"id": v.id, "ts": v.ts.isoformat() + "Z", "hash": v.content_hash,
                "text": store.read_version(v.commit_sha, rel)}


@router.post("/devices/{device_id}/backup")
async def backup_now(device_id: int):
    async with SessionLocal() as s:
        d = await s.get(Device, device_id)
        if d and d.capability == "readonly":
            raise HTTPException(409, "Device is read-only (controller-managed); config backup not available")
    return await store.backup_device(device_id, trigger="manual", user="api")


@router.get("/devices/{device_id}/configs/diff")
async def diff(device_id: int, a: int, b: int):
    async with SessionLocal() as s:
        va, vb, dev = await s.get(ConfigVersion, a), await s.get(ConfigVersion, b), await s.get(Device, device_id)
        if not (va and vb and dev):
            raise HTTPException(404)
        rel = store._device_path(dev)
        return {"diff": store.diff_versions(va.commit_sha, vb.commit_sha, rel)}


@router.post("/devices/{device_id}/restore/{version_id}")
async def restore(device_id: int, version_id: int):
    async with SessionLocal() as s:
        v = await s.get(ConfigVersion, version_id)
        if not v:
            raise HTTPException(404)
        sha = v.commit_sha
    return await store.restore_device(device_id, sha, user="api")


@router.post("/backup-all")
async def backup_all():
    async with SessionLocal() as s:
        ids = (await s.execute(select(Device.id))).scalars().all()
    results = [await store.backup_device(i, trigger="scheduled", user="api") for i in ids]
    return {"count": len(results), "changed": sum(1 for r in results if r.get("changed"))}


# ───────────────────────── WebSocket SSH proxy ─────────────────────────
@ws_router.websocket("/ssh/{device_id}")
async def ssh_ws(ws: WebSocket, device_id: int, token: str = ""):
    """Bridge a browser terminal to a device shell. Browser never sees creds.
    Auth: browsers can't set headers on WS, so the JWT arrives as ?token=."""
    # validate token before accepting
    user = user_from_token_str(token)
    if not user:
        await ws.close(code=4401)  # unauthorized
        return
    await ws.accept()
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
    if not dev:
        await ws.send_text("# device not found\r\n"); await ws.close(); return
    if dev.capability == "readonly":
        await ws.send_text("# This device is read-only (controller-managed). SSH is not available.\r\n")
        await ws.close(); return

    if settings.device_backend == "sim":
        await _sim_shell(ws, dev)
        return

    # real interactive shell via asyncssh
    import asyncssh
    user = dev.ssh_username or settings.default_ssh_username
    pw = dev.ssh_password or settings.default_ssh_password
    try:
        async with asyncssh.connect(dev.ip, port=dev.ssh_port, username=user,
                                    password=pw, known_hosts=None) as conn:
            proc = await conn.create_process(term_type="xterm", encoding="utf-8")
            await ws.send_text(f"# Connected to {dev.hostname} ({dev.ip})\r\n")

            async def pump_out():
                async for data in proc.stdout:
                    await ws.send_text(data)

            out_task = asyncio.create_task(pump_out())
            try:
                while True:
                    data = await ws.receive_text()
                    proc.stdin.write(data)
            finally:
                out_task.cancel()
    except WebSocketDisconnect:
        pass
    except Exception as e:  # noqa: BLE001
        await ws.send_text(f"# connection error: {e}\r\n")
        await ws.close()


async def _sim_shell(ws: WebSocket, dev):
    """Minimal simulated CLI so the terminal works without hardware."""
    await ws.send_text(f"# Connected to {dev.vendor} {dev.model} ({dev.os})\r\n{dev.hostname}# ")
    try:
        while True:
            line = (await ws.receive_text()).strip()
            if line in ("exit", "quit"):
                await ws.send_text("# session closed\r\n"); await ws.close(); return
            if line == "show running-config":
                await ws.send_text(drv._sim_running_config(dev) + "\r\n")
            elif line.startswith("show version"):
                await ws.send_text(f"{dev.vendor} {dev.model}\r\nOS: {dev.os}\r\n")
            elif line:
                await ws.send_text(f"% simulated — '{line}' acknowledged\r\n")
            await ws.send_text(f"{dev.hostname}# ")
    except WebSocketDisconnect:
        pass
