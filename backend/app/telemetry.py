"""
Telemetry: time-series collection and querying, backed by the existing Postgres.

Design kept deliberately lean for a small-business appliance — no extra service.
A scheduler job samples each device every `metrics_interval` seconds and writes
rows to metric_samples. A daily maintenance job downsamples raw rows older than
the raw-retention window into hourly aggregates, then prunes:

  raw rows     : kept metrics_raw_retention_days (default 7)
  hourly rows  : kept metrics_hourly_retention_days (default 90)

Metrics collected:
  cpu, mem        — device-level percentages
  reachable       — 1 if up, 0 if down (status timeline)
  if_rx, if_tx    — per-interface throughput (label = interface name)

In sim mode, plausible values are synthesized so the charts populate without
live devices; in real mode the device/connector drivers supply the numbers.
"""
import datetime as dt
import random
import math
import asyncio

from sqlalchemy import select, delete, func

from .config import settings
from .db import SessionLocal, Device, MetricSample
from . import connectors


# ───────────────────────── collection ──────────────────────────────────
async def collect_once(scope="open"):
    """Sample devices once and persist datapoints. `scope` selects which devices:
      "open"       — directly-managed (SNMP) devices only [default, fast interval]
      "controller" — controller-managed devices only [slower, API rate-limited]
      "all"        — every device
    Splitting the scopes lets open-protocol gear poll fast over SNMP without a
    fast interval blowing through controller API caps (e.g. Omada's daily limit)."""
    now = dt.datetime.utcnow()
    async with SessionLocal() as s:
        q = select(Device)
        if scope == "open":
            q = q.where(Device.controller_id.is_(None))
        elif scope == "controller":
            q = q.where(Device.controller_id.is_not(None))
        devices = (await s.execute(q)).scalars().all()
        rows = []
        for d in devices:
            cpu, mem, reachable, ifrates, uptime_secs = await _sample_device(d)
            rows.append(MetricSample(device_id=d.id, ts=now, metric="cpu", value=cpu))
            rows.append(MetricSample(device_id=d.id, ts=now, metric="mem", value=mem))
            rows.append(MetricSample(device_id=d.id, ts=now, metric="reachable", value=reachable))
            if uptime_secs:
                rows.append(MetricSample(device_id=d.id, ts=now, metric="uptime", value=uptime_secs))
            for ifname, m in ifrates.items():
                rows.append(MetricSample(device_id=d.id, ts=now, metric="if_rx", label=ifname, value=m.get("rx", 0)))
                rows.append(MetricSample(device_id=d.id, ts=now, metric="if_tx", label=ifname, value=m.get("tx", 0)))
                if m.get("in_err") or m.get("out_err"):
                    rows.append(MetricSample(device_id=d.id, ts=now, metric="if_inerr", label=ifname, value=m.get("in_err", 0)))
                    rows.append(MetricSample(device_id=d.id, ts=now, metric="if_outerr", label=ifname, value=m.get("out_err", 0)))
        # AP client-traffic throughput (controller scope): sum each AP's clients'
        # cumulative traffic counters and delta to bps, stored as if_rx/if_tx under
        # a "WLAN (clients)" label so APs appear in the existing interface charts.
        if scope in ("controller", "all"):
            try:
                rows += await _ap_client_throughput(devices, now)
            except Exception:  # noqa: BLE001
                pass
        s.add_all(rows)
        await s.commit()
    return len(rows)


# cache for AP client-traffic counter-delta: {ap_device_id: {"down":bytes,"up":bytes,"ts":float}}
_AP_TRAFFIC_CACHE = {}


async def _ap_client_throughput(devices, now):
    """For each controller-managed AP, sum connected clients' cumulative traffic
    counters and compute bps by diffing against the previous reading. Returns
    MetricSample rows (if_rx/if_tx, label 'WLAN (clients)')."""
    import time as _time
    aps = [d for d in devices if d.device_type == "ap" and d.controller_id]
    if not aps:
        return []
    # fetch clients per controller once, group by ap_mac/ap_name
    from .db import Controller
    by_ctrl = {}
    for d in aps:
        by_ctrl.setdefault(d.controller_id, []).append(d)
    out, ts = [], _time.time()
    for cid, ap_devs in by_ctrl.items():
        async with SessionLocal() as s:
            ctrl = await s.get(Controller, cid)
        if not ctrl:
            continue
        try:
            clients = await connectors.list_clients(ctrl)
        except Exception:  # noqa: BLE001
            continue
        # sum cumulative bytes per AP (match on mac first, then name)
        for ap in ap_devs:
            down = up = 0
            for c in clients:
                if c.get("ap_mac") == ap.external_id or c.get("ap_name") == ap.name:
                    down += int(c.get("traffic_down", 0) or 0)
                    up += int(c.get("traffic_up", 0) or 0)
            prev = _AP_TRAFFIC_CACHE.get(ap.id)
            rx_bps = tx_bps = 0.0
            if prev:
                dt_s = ts - prev["ts"]
                if dt_s > 0:
                    d_down, d_up = down - prev["down"], up - prev["up"]
                    # client roster changes can make the sum drop; treat as 0 not negative
                    if d_down >= 0:
                        rx_bps = d_down * 8 / dt_s
                    if d_up >= 0:
                        tx_bps = d_up * 8 / dt_s
            _AP_TRAFFIC_CACHE[ap.id] = {"down": down, "up": up, "ts": ts}
            out.append(MetricSample(device_id=ap.id, ts=now, metric="if_rx",
                                    label="WLAN (clients)", value=round(rx_bps, 1)))
            out.append(MetricSample(device_id=ap.id, ts=now, metric="if_tx",
                                    label="WLAN (clients)", value=round(tx_bps, 1)))
    return out


async def _sample_device(dev):
    """Return (cpu, mem, reachable, {iface: {rx, tx, in_err, out_err, status}}, uptime).
    Rates are bps; errors are per-second."""
    if settings.device_backend != "sim":
        if dev.controller_id:
            try:
                async with SessionLocal() as s:
                    from .db import Controller
                    ctrl = await s.get(Controller, dev.controller_id)
                m = await connectors.fetch_metrics(ctrl, dev.external_id)
                ports = {}
                for p in m.get("ports", [])[:16]:
                    nm = f"port{p.get('idx')}"
                    ports[nm] = {"rx": float(p.get("rx", 0) or 0), "tx": float(p.get("tx", 0) or 0),
                                 "in_err": 0, "out_err": 0,
                                 "status": "up" if p.get("up") else "down"}
                return (float(m.get("cpu", 0)), float(m.get("mem", 0)), 1.0, ports,
                        float(m.get("uptime", 0) or 0))
            except Exception:  # noqa: BLE001
                return 0, 0, 0.0, {}, 0.0
        # open-protocol devices: poll health + interface rates over SNMP
        community = dev.snmp_community or settings.default_snmp_community
        if community and dev.ip:
            try:
                from . import devices as drv
                m = await asyncio.to_thread(drv.snmp_metrics, dev.ip, community)
                reachable = 1.0 if m.get("reachable") else (1.0 if dev.status == "up" else 0.0)
                ifrates = {}
                try:
                    raw = await asyncio.to_thread(drv.snmp_interface_rates, dev.ip, community)
                    for nm, r in raw.items():
                        # store physical/active interfaces only — skip the long tail of
                        # logical/down ifs to keep the series count manageable
                        if r["status"] != "up" and r["rx_bps"] == 0 and r["tx_bps"] == 0:
                            continue
                        ifrates[nm] = {"rx": r["rx_bps"], "tx": r["tx_bps"],
                                       "in_err": r["in_err_ps"], "out_err": r["out_err_ps"],
                                       "status": r["status"]}
                except Exception:  # noqa: BLE001
                    ifrates = {}
                return (float(m.get("cpu", 0)), float(m.get("mem", 0)), reachable,
                        ifrates, float(m.get("uptime_secs", 0) or 0))
            except Exception:  # noqa: BLE001
                return 0, 0, (1.0 if dev.status == "up" else 0.0), {}, 0.0
        return (float(getattr(dev, "cpu", 0) or 0), float(getattr(dev, "mem", 0) or 0),
                (1.0 if dev.status == "up" else 0.0), {}, 0.0)

    # ── simulated: smooth, believable series driven by time + device id ──
    t = dt.datetime.utcnow().timestamp() / 600.0
    seed = dev.id
    base_cpu = 25 + (seed * 7) % 30
    cpu = max(1, min(99, base_cpu + 18 * math.sin(t + seed) + random.uniform(-4, 4)))
    mem = max(5, min(95, 40 + (seed * 5) % 25 + 10 * math.sin(t / 2 + seed) + random.uniform(-3, 3)))
    reachable = 0.0 if dev.status == "down" else 1.0
    ifaces = {}
    try:
        names = list((dev.interfaces or {}).keys())[:6] if hasattr(dev, "interfaces") and isinstance(getattr(dev, "interfaces", None), dict) else []
    except Exception:  # noqa: BLE001
        names = []
    if not names:
        names = ["Ethernet1", "Ethernet2", "Ethernet3"]
    for i, nm in enumerate(names):
        rx = max(0, 200 + 150 * math.sin(t + i + seed) + random.uniform(-40, 40))
        tx = max(0, 120 + 90 * math.sin(t / 1.5 + i + seed) + random.uniform(-30, 30))
        ifaces[nm] = {"rx": round(rx * 1e6, 1), "tx": round(tx * 1e6, 1),
                      "in_err": 0, "out_err": 0, "status": "up"}
    return round(cpu, 1), round(mem, 1), reachable, ifaces, float(86400 * (3 + seed % 60))


# ───────────────────────── maintenance (downsample + prune) ────────────
async def maintain():
    """Downsample raw rows older than the raw window into hourly aggregates,
    then prune beyond retention. Runs daily."""
    now = dt.datetime.utcnow()
    raw_cutoff = now - dt.timedelta(days=settings.metrics_raw_retention_days)
    hourly_cutoff = now - dt.timedelta(days=settings.metrics_hourly_retention_days)

    async with SessionLocal() as s:
        # group old raw rows into hourly buckets (avg) per device/metric/label
        old = (await s.execute(
            select(MetricSample).where(MetricSample.resolution == "raw",
                                       MetricSample.ts < raw_cutoff)
        )).scalars().all()

        buckets: dict[tuple, list] = {}
        for r in old:
            hour = r.ts.replace(minute=0, second=0, microsecond=0)
            buckets.setdefault((r.device_id, r.metric, r.label, hour), []).append(r.value)

        for (dev_id, metric, label, hour), vals in buckets.items():
            s.add(MetricSample(device_id=dev_id, ts=hour, metric=metric, label=label,
                               value=sum(vals) / len(vals), resolution="hourly"))
        # delete the raw rows we just rolled up
        if old:
            await s.execute(delete(MetricSample).where(MetricSample.resolution == "raw",
                                                       MetricSample.ts < raw_cutoff))
        # prune hourly beyond long retention
        await s.execute(delete(MetricSample).where(MetricSample.resolution == "hourly",
                                                   MetricSample.ts < hourly_cutoff))
        await s.commit()
    return len(old)


# ───────────────────────── query ───────────────────────────────────────
_RANGES = {"1h": 1, "6h": 6, "24h": 24, "7d": 24 * 7, "30d": 24 * 30}


async def query(device_id: int, metric: str, rng: str = "24h", label: str = ""):
    hours = _RANGES.get(rng, 24)
    since = dt.datetime.utcnow() - dt.timedelta(hours=hours)
    async with SessionLocal() as s:
        q = select(MetricSample.ts, MetricSample.value, MetricSample.label).where(
            MetricSample.device_id == device_id, MetricSample.metric == metric,
            MetricSample.ts >= since)
        if label:
            q = q.where(MetricSample.label == label)
        q = q.order_by(MetricSample.ts.asc())
        rows = (await s.execute(q)).all()

    if not label:
        return {"metric": metric, "range": rng,
                "points": [{"t": r.ts.isoformat() + "Z", "v": round(r.value, 2)} for r in rows]}
    return {"metric": metric, "range": rng, "label": label,
            "points": [{"t": r.ts.isoformat() + "Z", "v": round(r.value, 2)} for r in rows]}


async def query_interfaces(device_id: int, rng: str = "24h"):
    """Return per-interface rx/tx series for a device."""
    hours = _RANGES.get(rng, 24)
    since = dt.datetime.utcnow() - dt.timedelta(hours=hours)
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(MetricSample.ts, MetricSample.value, MetricSample.label, MetricSample.metric)
            .where(MetricSample.device_id == device_id,
                   MetricSample.metric.in_(("if_rx", "if_tx")),
                   MetricSample.ts >= since)
            .order_by(MetricSample.ts.asc())
        )).all()
    series: dict = {}
    for r in rows:
        series.setdefault(r.label, {"rx": [], "tx": []})
        key = "rx" if r.metric == "if_rx" else "tx"
        series[r.label][key].append({"t": r.ts.isoformat() + "Z", "v": round(r.value, 2)})
    return {"range": rng, "interfaces": series}


async def latest_summary(device_id: int):
    """Most recent cpu/mem/uptime for quick display."""
    async with SessionLocal() as s:
        out = {}
        for m in ("cpu", "mem"):
            row = (await s.execute(
                select(MetricSample.value).where(MetricSample.device_id == device_id,
                                                 MetricSample.metric == m)
                .order_by(MetricSample.ts.desc()).limit(1)
            )).scalar_one_or_none()
            out[m] = round(row, 1) if row is not None else None
        # uptime stored as seconds; format as "Nd Nh" for display
        up = (await s.execute(
            select(MetricSample.value).where(MetricSample.device_id == device_id,
                                             MetricSample.metric == "uptime")
            .order_by(MetricSample.ts.desc()).limit(1)
        )).scalar_one_or_none()
        if up is not None and up > 0:
            secs = int(up)
            out["uptime_secs"] = secs
            out["uptime"] = f"{secs // 86400}d {(secs % 86400) // 3600}h"
        else:
            out["uptime"] = None
    return out


async def fleet_summary():
    """Latest cpu/mem/uptime for every device, in one pass.
    Returns {device_id: {cpu, mem, uptime, uptime_secs}} for the inventory table."""
    out = {}
    async with SessionLocal() as s:
        for metric in ("cpu", "mem", "uptime"):
            sub = (select(MetricSample.device_id, func.max(MetricSample.ts).label("mx"))
                   .where(MetricSample.metric == metric)
                   .group_by(MetricSample.device_id)).subquery()
            rows = (await s.execute(
                select(MetricSample.device_id, MetricSample.value)
                .join(sub, (MetricSample.device_id == sub.c.device_id) & (MetricSample.ts == sub.c.mx))
                .where(MetricSample.metric == metric)
            )).all()
            for did, val in rows:
                d = out.setdefault(did, {})
                if metric == "uptime":
                    if val and val > 0:
                        secs = int(val)
                        d["uptime_secs"] = secs
                        d["uptime"] = f"{secs // 86400}d {(secs % 86400) // 3600}h"
                else:
                    d[metric] = round(val, 1) if val is not None else None
    return out
