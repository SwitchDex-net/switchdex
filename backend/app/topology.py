"""
Topology graph.

Topology is *derived*, not stored: nodes are devices, links are LLDP/CDP
neighbor relationships discovered on each device. This endpoint assembles the
graph the frontend renders. In sim mode it infers a plausible core/dist/access
hierarchy so the map is populated without live neighbor discovery.
"""
import json

from fastapi import APIRouter, Depends
from sqlalchemy import select

from .db import SessionLocal, Device
from .auth import get_current_user
from .config import settings

router = APIRouter(prefix="/api/topology", dependencies=[Depends(get_current_user)])


@router.get("")
async def get_topology(_: dict = Depends(get_current_user)):
    async with SessionLocal() as s:
        devices = (await s.execute(select(Device))).scalars().all()

    by_ip = {d.ip: d for d in devices}
    nodes = [{
        "id": d.id, "name": d.name, "ip": d.ip, "type": d.device_type,
        "vendor": d.vendor, "status": d.status, "role": d.role,
        "source": d.source, "capability": d.capability,
    } for d in devices]

    links = []
    seen = set()

    if settings.device_backend == "sim":
        links = _infer_links(devices)
    else:
        # real mode: build edges from each device's discovered neighbors
        for d in devices:
            if not d.neighbors_json:
                continue
            try:
                neighbors = json.loads(d.neighbors_json)
            except ValueError:
                continue
            for nb in neighbors:
                peer = by_ip.get(nb.get("peer_ip"))
                if not peer:
                    continue
                key = tuple(sorted((d.id, peer.id)))
                if key in seen:
                    continue
                seen.add(key)
                links.append({
                    "source": d.id, "target": peer.id,
                    "local_if": nb.get("local_if", ""), "peer_if": nb.get("peer_if", ""),
                    "status": "up" if d.status == "up" and peer.status == "up" else "down",
                })

    return {"nodes": nodes, "links": links}


def _infer_links(devices):
    """Sim-mode heuristic: connect access→distribution→core by role, so the
    map shows a believable hierarchy without real LLDP data."""
    by_role = {"core": [], "distribution": [], "access": [], "edge": []}
    for d in devices:
        role = d.role if d.role in by_role else _guess_role(d)
        by_role[role].append(d)

    links = []
    def connect(a, b):
        links.append({"source": a.id, "target": b.id, "local_if": "", "peer_if": "",
                      "status": "up" if a.status == "up" and b.status == "up" else "down"})

    # mesh cores together
    cores = by_role["core"]
    for i in range(len(cores)):
        for j in range(i + 1, len(cores)):
            connect(cores[i], cores[j])
    # each distribution to a core (round-robin)
    for i, d in enumerate(by_role["distribution"]):
        if cores:
            connect(d, cores[i % len(cores)])
    # each access to a distribution (or core if none)
    uplinks = by_role["distribution"] or cores
    for i, a in enumerate(by_role["access"]):
        if uplinks:
            connect(a, uplinks[i % len(uplinks)])
    # edge/firewall to a core
    for e in by_role["edge"]:
        if cores:
            connect(e, cores[0])
    return links


def _guess_role(d):
    n = (d.name + " " + d.device_type).lower()
    if d.device_type == "firewall" or "edge" in n or "perimeter" in n:
        return "edge"
    if "core" in n:
        return "core"
    if "dist" in n:
        return "distribution"
    if d.device_type == "router":
        return "core"
    return "access"
