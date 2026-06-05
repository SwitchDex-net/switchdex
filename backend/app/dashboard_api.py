"""Shared, org-wide dashboard layout — a single saved arrangement of cards
that all users see. Editing is admin-gated; viewing is open to any user."""
import json
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from .auth import get_current_user, require_admin
from .db import SessionLocal, Setting

router = APIRouter(prefix="/api/dashboard", dependencies=[Depends(get_current_user)])

_KEY = "dashboard_layout"

# Default layout used until an admin customizes it. Card `type` values must match
# what the frontend knows how to render; `config` is card-type-specific.
_DEFAULT = [
    {"id": "kpis",    "type": "kpis",        "config": {}},
    {"id": "health",  "type": "fleet_health", "config": {}},
    {"id": "alerts",  "type": "recent_alerts", "config": {}},
]


class Layout(BaseModel):
    cards: list


@router.get("/layout")
async def get_layout(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        row = await s.get(Setting, _KEY)
        if row and row.value:
            try:
                cards = json.loads(row.value)
                if isinstance(cards, list):
                    return {"cards": cards}
            except Exception:  # noqa: BLE001
                pass
    return {"cards": _DEFAULT}


@router.put("/layout", dependencies=[Depends(require_admin)])
async def put_layout(body: Layout):
    if not isinstance(body.cards, list):
        raise HTTPException(400, "cards must be a list")
    async with SessionLocal() as s:
        row = await s.get(Setting, _KEY)
        payload = json.dumps(body.cards)
        if row:
            row.value = payload
        else:
            s.add(Setting(key=_KEY, value=payload))
        await s.commit()
    return {"ok": True, "cards": body.cards}
