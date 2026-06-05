"""Automations API — manage trigger→action rules, review run history, and
approve/reject queued remediation. Editing is admin-gated; remediation approval
is admin-gated."""
import json
import datetime as dt
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc

from .auth import get_current_user, require_admin
from .db import SessionLocal, Automation, AutomationRun
from . import automations as engine

router = APIRouter(prefix="/api/automations", dependencies=[Depends(get_current_user)])


def _to_dict(a: Automation):
    return {
        "id": a.id, "name": a.name, "description": a.description, "enabled": a.enabled,
        "trigger_type": a.trigger_type, "trigger": json.loads(a.trigger_json or "{}"),
        "scope_type": a.scope_type, "scope": json.loads(a.scope_json or "{}"),
        "condition": json.loads(a.condition_json or "{}"),
        "action_type": a.action_type, "action": json.loads(a.action_json or "{}"),
        "is_remediation": a.action_type in engine.REMEDIATION_ACTIONS,
        "requires_approval": a.requires_approval, "armed": a.armed,
        "cooldown_minutes": a.cooldown_minutes, "max_devices_per_run": a.max_devices_per_run,
        "protect_uplink": a.protect_uplink,
        "last_fired_at": a.last_fired_at.isoformat() + "Z" if a.last_fired_at else None,
    }


class AutomationIn(BaseModel):
    name: str
    description: str = ""
    enabled: bool = True
    trigger_type: str = "event"
    trigger: dict = {}
    scope_type: str = "all"
    scope: dict = {}
    condition: dict = {}
    action_type: str = "notify"
    action: dict = {}
    requires_approval: bool = True
    armed: bool = False
    cooldown_minutes: int = 15
    max_devices_per_run: int = 5
    protect_uplink: bool = True


@router.get("")
async def list_automations(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(select(Automation).order_by(Automation.id))).scalars().all()
        return [_to_dict(a) for a in rows]


@router.post("", dependencies=[Depends(require_admin)])
async def create_automation(body: AutomationIn):
    a = Automation(
        name=body.name, description=body.description, enabled=body.enabled,
        trigger_type=body.trigger_type, trigger_json=json.dumps(body.trigger),
        scope_type=body.scope_type, scope_json=json.dumps(body.scope),
        condition_json=json.dumps(body.condition),
        action_type=body.action_type, action_json=json.dumps(body.action),
        is_remediation=body.action_type in engine.REMEDIATION_ACTIONS,
        requires_approval=body.requires_approval, armed=body.armed,
        cooldown_minutes=body.cooldown_minutes, max_devices_per_run=body.max_devices_per_run,
        protect_uplink=body.protect_uplink)
    async with SessionLocal() as s:
        s.add(a); await s.commit(); await s.refresh(a)
        return _to_dict(a)


@router.put("/{aid}", dependencies=[Depends(require_admin)])
async def update_automation(aid: int, body: AutomationIn):
    async with SessionLocal() as s:
        a = await s.get(Automation, aid)
        if not a:
            raise HTTPException(404)
        a.name = body.name; a.description = body.description; a.enabled = body.enabled
        a.trigger_type = body.trigger_type; a.trigger_json = json.dumps(body.trigger)
        a.scope_type = body.scope_type; a.scope_json = json.dumps(body.scope)
        a.condition_json = json.dumps(body.condition)
        a.action_type = body.action_type; a.action_json = json.dumps(body.action)
        a.is_remediation = body.action_type in engine.REMEDIATION_ACTIONS
        a.requires_approval = body.requires_approval; a.armed = body.armed
        a.cooldown_minutes = body.cooldown_minutes; a.max_devices_per_run = body.max_devices_per_run
        a.protect_uplink = body.protect_uplink
        await s.commit(); await s.refresh(a)
        return _to_dict(a)


@router.delete("/{aid}", dependencies=[Depends(require_admin)])
async def delete_automation(aid: int):
    async with SessionLocal() as s:
        a = await s.get(Automation, aid)
        if a:
            await s.delete(a); await s.commit()
    return {"ok": True}


@router.post("/{aid}/test", dependencies=[Depends(require_admin)])
async def test_automation(aid: int):
    """Fire an automation now as a forced dry-run, to preview what it would do
    without applying anything (even if armed)."""
    async with SessionLocal() as s:
        a = await s.get(Automation, aid)
        if not a:
            raise HTTPException(404)
        devices = await engine._resolve_scope(a, s)
        capped = devices[: max(1, a.max_devices_per_run or 1)]
        detail = await engine._run_action(a, capped, s, dry_run=True)
    return {"preview": detail, "devices": len(capped)}


@router.get("/runs")
async def list_runs(limit: int = 50, _: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(AutomationRun).order_by(desc(AutomationRun.ts)).limit(limit))).scalars().all()
        autos = {a.id: a.name for a in (await s.execute(select(Automation))).scalars().all()}
        return [{
            "id": r.id, "automation_id": r.automation_id,
            "automation": autos.get(r.automation_id, "(deleted)"),
            "ts": r.ts.isoformat() + "Z", "trigger": r.trigger_summary,
            "status": r.status, "detail": r.detail,
            "device_ids": json.loads(r.device_ids_json or "[]"),
            "approved_by": r.approved_by,
            "approved_at": r.approved_at.isoformat() + "Z" if r.approved_at else None,
        } for r in rows]


@router.get("/pending")
async def list_pending(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(AutomationRun).where(AutomationRun.status == "pending_approval")
            .order_by(desc(AutomationRun.ts)))).scalars().all()
        autos = {a.id: a.name for a in (await s.execute(select(Automation))).scalars().all()}
        return [{
            "id": r.id, "automation": autos.get(r.automation_id, "(deleted)"),
            "ts": r.ts.isoformat() + "Z", "trigger": r.trigger_summary,
            "detail": r.detail, "device_ids": json.loads(r.device_ids_json or "[]"),
        } for r in rows]


class Approval(BaseModel):
    approve: bool = True


@router.post("/runs/{run_id}/approve", dependencies=[Depends(require_admin)])
async def approve(run_id: int, body: Approval, user: dict = Depends(get_current_user)):
    run = await engine.approve_run(run_id, user.get("username", "admin"), approve=body.approve)
    if not run:
        raise HTTPException(404, "no such pending run")
    return {"ok": True, "status": run.status, "detail": run.detail}
