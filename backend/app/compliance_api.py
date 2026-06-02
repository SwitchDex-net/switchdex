"""Compliance API: policy CRUD, per-device baseline pinning, dashboard."""
import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from .db import (SessionLocal, CompliancePolicy, DeviceBaseline, Device,
                 ConfigVersion)
from .auth import get_current_user, require_admin
from . import compliance as engine
from . import configstore as store

router = APIRouter(prefix="/api/compliance", dependencies=[Depends(get_current_user)])


# ───────────────────────── dashboard ───────────────────────────────────
@router.get("")
async def dashboard(_: dict = Depends(get_current_user)):
    return await engine.evaluate_fleet()


@router.get("/devices/{device_id}")
async def device_detail(device_id: int, _: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        if not dev:
            raise HTTPException(404)
        policies = (await s.execute(select(CompliancePolicy))).scalars().all()
        baselines = {b.device_id: b for b in
                     (await s.execute(select(DeviceBaseline))).scalars().all()}
    return await engine.evaluate_device(dev, policies, baselines)


# ───────────────────────── policies (admin) ────────────────────────────
class PolicyIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    kind: str = "require"           # require | forbid
    pattern: str = ""
    match: str = "substring"        # substring | regex
    severity: str = "warning"
    scope: str = ""


def _pol_out(p: CompliancePolicy):
    return {k: getattr(p, k) for k in
            ("id", "name", "description", "enabled", "kind", "pattern",
             "match", "severity", "scope")}


@router.get("/policies")
async def list_policies(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        return [_pol_out(p) for p in (await s.execute(select(CompliancePolicy))).scalars().all()]


@router.post("/policies", dependencies=[Depends(require_admin)])
async def create_policy(body: PolicyIn):
    async with SessionLocal() as s:
        p = CompliancePolicy(**body.model_dump())
        s.add(p); await s.commit(); await s.refresh(p)
        return _pol_out(p)


@router.put("/policies/{pid}", dependencies=[Depends(require_admin)])
async def update_policy(pid: int, body: PolicyIn):
    async with SessionLocal() as s:
        p = await s.get(CompliancePolicy, pid)
        if not p:
            raise HTTPException(404)
        for k, v in body.model_dump().items():
            setattr(p, k, v)
        await s.commit()
        return _pol_out(p)


@router.delete("/policies/{pid}", dependencies=[Depends(require_admin)])
async def delete_policy(pid: int):
    async with SessionLocal() as s:
        p = await s.get(CompliancePolicy, pid)
        if not p:
            raise HTTPException(404)
        await s.delete(p); await s.commit()
    return {"ok": True}


# ───────────────────────── baselines (admin) ───────────────────────────
@router.get("/baselines")
async def list_baselines(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(select(DeviceBaseline))).scalars().all()
        return [{"deviceId": b.device_id, "versionId": b.version_id,
                 "hash": b.content_hash, "pinnedBy": b.pinned_by,
                 "pinnedAt": b.pinned_at.isoformat() + "Z"} for b in rows]


@router.post("/baselines/{device_id}/pin/{version_id}", dependencies=[Depends(require_admin)])
async def pin_baseline(device_id: int, version_id: int, user: dict = Depends(require_admin)):
    """Mark a config version as the golden baseline for a device."""
    async with SessionLocal() as s:
        ver = await s.get(ConfigVersion, version_id)
        if not ver or ver.device_id != device_id:
            raise HTTPException(404, "version not found for this device")
        existing = (await s.execute(
            select(DeviceBaseline).where(DeviceBaseline.device_id == device_id)
        )).scalar_one_or_none()
        if existing:
            existing.version_id = version_id; existing.commit_sha = ver.commit_sha
            existing.content_hash = ver.content_hash; existing.pinned_by = user["username"]
            existing.pinned_at = dt.datetime.utcnow()
        else:
            s.add(DeviceBaseline(device_id=device_id, version_id=version_id,
                                 commit_sha=ver.commit_sha, content_hash=ver.content_hash,
                                 pinned_by=user["username"]))
        await s.commit()
    return {"ok": True}


@router.delete("/baselines/{device_id}", dependencies=[Depends(require_admin)])
async def unpin_baseline(device_id: int):
    async with SessionLocal() as s:
        b = (await s.execute(
            select(DeviceBaseline).where(DeviceBaseline.device_id == device_id)
        )).scalar_one_or_none()
        if b:
            await s.delete(b); await s.commit()
    return {"ok": True}


@router.get("/devices/{device_id}/drift")
async def baseline_drift(device_id: int, _: dict = Depends(get_current_user)):
    """Unified diff between the pinned baseline and the current config."""
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        b = (await s.execute(
            select(DeviceBaseline).where(DeviceBaseline.device_id == device_id)
        )).scalar_one_or_none()
        if not dev or not b:
            raise HTTPException(404, "no baseline pinned")
        last = (await s.execute(
            select(ConfigVersion).where(ConfigVersion.device_id == device_id)
            .order_by(ConfigVersion.ts.desc()).limit(1)
        )).scalar_one_or_none()
    rel = store._device_path(dev)
    if not last:
        return {"diff": "", "drift": False}
    diff = store.diff_versions(b.commit_sha, last.commit_sha, rel)
    return {"diff": diff, "drift": bool(diff.strip())}
