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

from sqlalchemy import select, delete, func

from .config import settings
from .db import SessionLocal, Device, MetricSample
from . import connectors


# ───────────────────────── collection ──────────────────────────────────
async def collect_once():
    """Sample every device once and persist the datapoints."""
    now = dt.datetime.utcnow()
    async with SessionLocal() as s:
        devices = (await s.execute(select(Device))).scalars().all()
        rows = []
        for d in devices:
            cpu, mem, reachable, ifrates = await _sample_device(d)
            rows.append(MetricSample(device_id=d.id, ts=now, metric="cpu", value=cpu))
            rows.append(MetricSample(device_id=d.id, ts=now, metric="mem", value=mem))
            rows.append(MetricSample(device_id=d.id, ts=now, metric="reachable", value=reachable))
            for ifname, (rx, tx) in ifrates.items():
                rows.append(MetricSample(device_id=d.id, ts=now, metric="if_rx", label=ifname, value=rx))
                rows.append(MetricSample(device_id=d.id, ts=now, metric="if_tx", label=ifname, value=tx))
        s.add_all(rows)
        await s.commit()
    return len(rows)


async def _sample_device(dev):
    """Return (cpu, mem, reachable, {iface: (rx_mbps, tx_mbps)})."""
    if settings.device_backend != "sim":
        # real mode: controller-managed devices expose metrics via their API;
        # open-protocol devices would be polled via SNMP/streaming telemetry.
        if dev.controller_id:
            try:
                async with SessionLocal() as s:
                    from .db import Controller
                    ctrl = await s.get(Controller, dev.controller_id)
                m = await connectors.fetch_metrics(ctrl, dev.external_id)
                ports = {f"port{p.get('idx')}": (float(p.get("rx", 0) or 0) / 1e6,
                                                 float(p.get("tx", 0) or 0) / 1e6)
                         for p in m.get("ports", [])[:8]}
                return float(m.get("cpu", 0)), float(m.get("mem", 0)), 1.0, ports
            except Exception:  # noqa: BLE001
                return 0, 0, 0.0, {}
        # open-protocol real polling hook would go here (SNMP ifHCInOctets etc.)
        return float(getattr(dev, "cpu", 0) or 0), float(getattr(dev, "mem", 0) or 0), \
            (1.0 if dev.status == "up" else 0.0), {}

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
        ifaces[nm] = (round(rx, 1), round(tx, 1))
    return round(cpu, 1), round(mem, 1), reachable, ifaces


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
    """Most recent cpu/mem for quick display."""
    async with SessionLocal() as s:
        out = {}
        for m in ("cpu", "mem"):
            row = (await s.execute(
                select(MetricSample.value).where(MetricSample.device_id == device_id,
                                                 MetricSample.metric == m)
                .order_by(MetricSample.ts.desc()).limit(1)
            )).scalar_one_or_none()
            out[m] = round(row, 1) if row is not None else None
    return out
