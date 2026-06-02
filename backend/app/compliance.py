"""
Compliance engine.

Two complementary checks per device:

  policy   — required/forbidden config-content rules applied fleet-wide.
             `require` fails if the pattern is absent; `forbid` fails if present.
             Matching is substring or regex.

  baseline — optional per-device golden snapshot. Drift = current running-config
             differs from the pinned version (compared by content hash; the diff
             is available on demand from the archive).

Evaluation pulls the current running-config from the archive engine (same source
the backup uses), so compliance reflects the latest known config. Read-only
controller-managed devices are skipped — they have no manageable config.
"""
import re

from sqlalchemy import select

from .db import (SessionLocal, Device, CompliancePolicy, DeviceBaseline,
                 ConfigVersion)
from . import configstore as store
from . import devices as drv


async def _current_config(dev) -> str:
    """Latest config text for a device — prefer the newest archived version,
    fall back to a live pull."""
    async with SessionLocal() as s:
        last = (await s.execute(
            select(ConfigVersion).where(ConfigVersion.device_id == dev.id)
            .order_by(ConfigVersion.ts.desc()).limit(1)
        )).scalar_one_or_none()
    if last:
        rel = store._device_path(dev)
        text = store.read_version(last.commit_sha, rel)
        if text:
            return text
    try:
        return await drv.pull_running_config(dev)
    except Exception:  # noqa: BLE001
        return ""


def _policy_pass(policy, config_text) -> bool:
    present = _contains(config_text, policy.pattern, policy.match)
    return present if policy.kind == "require" else (not present)


def _contains(text, pattern, match) -> bool:
    if not pattern:
        return False
    if match == "regex":
        try:
            return re.search(pattern, text, re.MULTILINE) is not None
        except re.error:
            return False
    return pattern in text


def _scoped(scope, device_id) -> bool:
    if not scope:
        return True
    ids = {int(x) for x in scope.split(",") if x.strip().isdigit()}
    return device_id in ids


async def evaluate_device(dev, policies, baselines) -> dict:
    """Return a compliance result for one device."""
    config = await _current_config(dev)
    checks = []
    for p in policies:
        if not p.enabled or not _scoped(p.scope, dev.id):
            continue
        ok = _policy_pass(p, config)
        checks.append({"id": p.id, "name": p.name, "kind": p.kind,
                       "severity": p.severity, "pass": ok})

    # baseline drift
    drift = None
    base = baselines.get(dev.id)
    if base:
        cur_hash = store.content_hash(config) if config else ""
        drift = (cur_hash != base.content_hash)

    failed = [c for c in checks if not c["pass"]]
    crit = any(c["severity"] == "critical" for c in failed)
    if failed or drift:
        status = "fail" if crit or failed else "drift"
    else:
        status = "pass"

    return {
        "deviceId": dev.id, "device": dev.name, "ip": dev.ip, "vendor": dev.vendor,
        "status": status, "checks": checks,
        "passed": sum(1 for c in checks if c["pass"]),
        "total": len(checks),
        "drift": drift, "hasBaseline": base is not None,
    }


async def evaluate_fleet() -> dict:
    async with SessionLocal() as s:
        devices = (await s.execute(
            select(Device).where(Device.capability == "manage"))).scalars().all()
        policies = (await s.execute(select(CompliancePolicy))).scalars().all()
        baselines = {b.device_id: b for b in
                     (await s.execute(select(DeviceBaseline))).scalars().all()}

    results = [await evaluate_device(d, policies, baselines) for d in devices]
    total = len(results)
    passing = sum(1 for r in results if r["status"] == "pass")
    score = round(100 * passing / total) if total else 100
    return {
        "score": score, "total": total, "passing": passing,
        "failing": sum(1 for r in results if r["status"] == "fail"),
        "drift": sum(1 for r in results if r["status"] == "drift"),
        "policyCount": len(policies),
        "results": results,
    }
