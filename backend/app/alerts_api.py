"""Alerts API: rule CRUD, alert lifecycle (ack/resolve), notification channels."""
import json
import datetime as dt

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from .db import SessionLocal, AlertRule, Alert, NotifyChannel, Device
from .auth import get_current_user, require_admin
from . import notify

router = APIRouter(prefix="/api/alerts", dependencies=[Depends(get_current_user)])


# ───────────────────────── alerts (lifecycle) ──────────────────────────
@router.get("")
async def list_alerts(state: str = "", _: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        q = select(Alert).order_by(Alert.opened_at.desc())
        if state:
            q = q.where(Alert.state == state)
        rows = (await s.execute(q.limit(500))).scalars().all()
        devs = {d.id: d.name for d in (await s.execute(select(Device))).scalars().all()}
        return [{
            "id": a.id, "severity": a.severity, "title": a.title, "detail": a.detail,
            "state": a.state, "device": devs.get(a.device_id, ""), "deviceId": a.device_id,
            "openedAt": a.opened_at.isoformat() + "Z",
            "ackAt": a.ack_at.isoformat() + "Z" if a.ack_at else None, "ackBy": a.ack_by,
            "resolvedAt": a.resolved_at.isoformat() + "Z" if a.resolved_at else None,
            "resolvedBy": a.resolved_by,
        } for a in rows]


@router.get("/summary")
async def summary(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        rows = (await s.execute(select(Alert).where(Alert.state != "resolved"))).scalars().all()
        return {
            "open": sum(1 for a in rows if a.state == "open"),
            "acknowledged": sum(1 for a in rows if a.state == "acknowledged"),
            "critical": sum(1 for a in rows if a.severity == "critical"),
            "warning": sum(1 for a in rows if a.severity == "warning"),
        }


@router.post("/{alert_id}/ack")
async def ack(alert_id: int, user: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        a = await s.get(Alert, alert_id)
        if not a:
            raise HTTPException(404)
        a.state = "acknowledged"; a.ack_at = dt.datetime.utcnow(); a.ack_by = user["username"]
        await s.commit()
    return {"ok": True}


@router.post("/{alert_id}/resolve")
async def resolve(alert_id: int, user: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        a = await s.get(Alert, alert_id)
        if not a:
            raise HTTPException(404)
        a.state = "resolved"; a.resolved_at = dt.datetime.utcnow(); a.resolved_by = user["username"]
        await s.commit()
    return {"ok": True}


# ───────────────────────── rules (admin) ───────────────────────────────
class RuleIn(BaseModel):
    name: str
    enabled: bool = True
    preset: str = "custom"
    metric: str = ""
    operator: str = ">"
    threshold: float = 0
    duration: int = 0
    severity: str = "warning"
    scope: str = ""
    auto_resolve: bool = True


def _rule_out(r: AlertRule):
    return {k: getattr(r, k) for k in
            ("id", "name", "enabled", "preset", "metric", "operator", "threshold",
             "duration", "severity", "scope", "auto_resolve")}


@router.get("/rules")
async def list_rules(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        return [_rule_out(r) for r in (await s.execute(select(AlertRule))).scalars().all()]


@router.post("/rules", dependencies=[Depends(require_admin)])
async def create_rule(body: RuleIn):
    async with SessionLocal() as s:
        r = AlertRule(**body.model_dump())
        s.add(r); await s.commit(); await s.refresh(r)
        return _rule_out(r)


@router.put("/rules/{rule_id}", dependencies=[Depends(require_admin)])
async def update_rule(rule_id: int, body: RuleIn):
    async with SessionLocal() as s:
        r = await s.get(AlertRule, rule_id)
        if not r:
            raise HTTPException(404)
        for k, v in body.model_dump().items():
            setattr(r, k, v)
        await s.commit()
        return _rule_out(r)


@router.delete("/rules/{rule_id}", dependencies=[Depends(require_admin)])
async def delete_rule(rule_id: int):
    async with SessionLocal() as s:
        r = await s.get(AlertRule, rule_id)
        if not r:
            raise HTTPException(404)
        await s.delete(r); await s.commit()
    return {"ok": True}


# ───────────────────────── channels (admin) ────────────────────────────
class ChannelIn(BaseModel):
    name: str
    kind: str                 # email|webhook|syslog|discord
    enabled: bool = True
    config: dict = {}
    min_severity: str = "warning"


def _chan_out(c: NotifyChannel):
    try:
        cfg = json.loads(c.config_json or "{}")
    except ValueError:
        cfg = {}
    # mask secrets before sending to the UI
    for secret in ("password", "client_secret"):
        if cfg.get(secret):
            cfg[secret] = "********"
    return {"id": c.id, "name": c.name, "kind": c.kind, "enabled": c.enabled,
            "config": cfg, "min_severity": c.min_severity}


@router.get("/channels")
async def list_channels(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        return [_chan_out(c) for c in (await s.execute(select(NotifyChannel))).scalars().all()]


@router.post("/channels", dependencies=[Depends(require_admin)])
async def create_channel(body: ChannelIn):
    async with SessionLocal() as s:
        c = NotifyChannel(name=body.name, kind=body.kind, enabled=body.enabled,
                          config_json=json.dumps(body.config), min_severity=body.min_severity)
        s.add(c); await s.commit(); await s.refresh(c)
        return _chan_out(c)


@router.put("/channels/{cid}", dependencies=[Depends(require_admin)])
async def update_channel(cid: int, body: ChannelIn):
    async with SessionLocal() as s:
        c = await s.get(NotifyChannel, cid)
        if not c:
            raise HTTPException(404)
        cfg = body.config
        # preserve masked secrets if the UI echoed the mask back
        try:
            old = json.loads(c.config_json or "{}")
        except ValueError:
            old = {}
        for secret in ("password", "client_secret"):
            if cfg.get(secret) == "********":
                cfg[secret] = old.get(secret, "")
        c.name = body.name; c.kind = body.kind; c.enabled = body.enabled
        c.config_json = json.dumps(cfg); c.min_severity = body.min_severity
        await s.commit()
        return _chan_out(c)


@router.delete("/channels/{cid}", dependencies=[Depends(require_admin)])
async def delete_channel(cid: int):
    async with SessionLocal() as s:
        c = await s.get(NotifyChannel, cid)
        if not c:
            raise HTTPException(404)
        await s.delete(c); await s.commit()
    return {"ok": True}


@router.post("/channels/test", dependencies=[Depends(require_admin)])
async def test_channel(body: ChannelIn):
    return notify.test_channel(body.kind, body.config)
