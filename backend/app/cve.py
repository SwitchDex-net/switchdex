"""Vulnerability scanning via the NIST NVD (National Vulnerability Database).

Design: a periodic background job pulls CVEs incrementally from the NVD API 2.0
into a local `cves` table; matching then runs locally against device CPEs, so
scans are instant and resilient to NVD's well-known rate limits / downtime.

Matching is deliberately TIGHT: a device must have a resolved CPE (vendor +
product + exact version), and a CVE's CPE applicability statement must match
that vendor/product with the device version falling in the affected range.
This minimizes false positives at the cost of needing per-vendor CPE mapping,
which we tune for the actual fleet (Cisco IOS, OPNsense, TP-Link/Omada, …).
"""
import os
import json
import time
import logging
import datetime as dt

import requests
from sqlalchemy import select, delete, func

from .db import SessionLocal, Cve, DeviceCve, Device
from .config import settings

log = logging.getLogger("cve")

NVD_API = "https://services.nvd.nist.gov/rest/json/cves/2.0"


# ─────────────────────────── CPE derivation ────────────────────────────
# Map a device (vendor / platform / os string) to a CPE 2.3 product prefix.
# We return (part, vendor, product) — the version is appended from the device.
# Tight matching: if we can't confidently map a device, we return None and it
# simply isn't scanned (better than guessing and raising false alarms).
#
# CPE format: cpe:2.3:<part>:<vendor>:<product>:<version>:...
#   part: 'o' (OS), 'a' (application), 'h' (hardware)
_CPE_MAP = [
    # (predicate over (vendor_lc, platform_lc, os_lc), (part, cpe_vendor, cpe_product))
    # Cisco IOS / IOS-XE — the os string distinguishes them.
    (lambda v, p, o: "cisco" in v and "xe" in o,           ("o", "cisco", "ios_xe")),
    (lambda v, p, o: "cisco" in v and "nx-os" in o,        ("o", "cisco", "nx-os")),
    (lambda v, p, o: "cisco" in v,                         ("o", "cisco", "ios")),
    # OPNsense / pfSense (classified as linux/freebsd by us).
    (lambda v, p, o: "opnsense" in o or "opnsense" in v,   ("o", "opnsense", "opnsense")),
    (lambda v, p, o: "pfsense" in o or "pfsense" in v,     ("o", "netgate", "pfsense")),
    # Arista EOS.
    (lambda v, p, o: "arista" in v or p == "eos",          ("o", "arista", "eos")),
    # Juniper Junos.
    (lambda v, p, o: "juniper" in v or p == "junos",       ("o", "juniper", "junos")),
    # TP-Link / Omada APs — firmware CVEs are sparse/!well-CPE'd; map by model
    # at the hardware level. Often yields no matches, which is honest.
    (lambda v, p, o: "tp-link" in v or "omada" in v,       ("h", "tp-link", "")),
]


def _version_from(dev) -> str:
    """Best-effort extract a clean version string from the device's os field.
    e.g. 'Cisco IOS Software ... Version 16.12.5b' -> '16.12.5b'."""
    import re
    text = f"{dev.os} {dev.model}"
    m = re.search(r"[Vv]ersion\s+([0-9][0-9A-Za-z._-]+)", text)
    if m:
        return m.group(1).rstrip(".,;")
    # OPNsense reports like 'OPNsense 24.1.10_8'
    m = re.search(r"\b(\d+\.\d+[0-9A-Za-z._-]*)\b", text)
    return m.group(1) if m else ""


def derive_cpe(dev) -> str:
    """Return a CPE 2.3 string for the device, or '' if we can't map it."""
    v = (dev.vendor or "").lower()
    p = (dev.platform or "").lower()
    o = (dev.os or "").lower()
    for pred, (part, cpe_v, cpe_p) in _CPE_MAP:
        try:
            if pred(v, p, o):
                if not cpe_p:
                    return ""   # hardware-only mapping w/o product -> skip (tight)
                ver = _version_from(dev) or "*"
                return f"cpe:2.3:{part}:{cpe_v}:{cpe_p}:{ver}:*:*:*:*:*:*:*"
        except Exception:  # noqa: BLE001
            continue
    return ""


# ─────────────────────────── version compare ───────────────────────────
def _ver_tuple(v: str):
    """Loose version tokenizer for comparison: '16.12.5b' -> (16,12,5,'b')."""
    import re
    parts = re.split(r"[.\-_]", v)
    out = []
    for p in parts:
        m = re.match(r"(\d+)([a-zA-Z]*)", p)
        if m:
            out.append(int(m.group(1)))
            if m.group(2):
                out.append(m.group(2))
        elif p:
            out.append(p)
    return tuple(out)


def _ver_cmp(a: str, b: str) -> int:
    """Return -1/0/1 comparing version a vs b. Best-effort, tolerant."""
    ta, tb = _ver_tuple(a), _ver_tuple(b)
    for x, y in zip(ta, tb):
        if type(x) != type(y):
            x, y = str(x), str(y)
        if x < y:
            return -1
        if x > y:
            return 1
    return (len(ta) > len(tb)) - (len(ta) < len(tb))


def _in_range(ver: str, node: dict) -> bool:
    """Does `ver` fall in a CPE match node's version range?"""
    if not ver or ver == "*":
        return False
    si, se = node.get("versionStartIncluding"), node.get("versionStartExcluding")
    ei, ee = node.get("versionEndIncluding"), node.get("versionEndExcluding")
    exact = node.get("_exact_version")
    if exact and exact not in ("*", "-"):
        return _ver_cmp(ver, exact) == 0
    if not any([si, se, ei, ee]):
        return False
    if si and _ver_cmp(ver, si) < 0:
        return False
    if se and _ver_cmp(ver, se) <= 0:
        return False
    if ei and _ver_cmp(ver, ei) > 0:
        return False
    if ee and _ver_cmp(ver, ee) >= 0:
        return False
    return True


# ─────────────────────────── NVD sync ──────────────────────────────────
def _nvd_headers():
    key = os.environ.get("NVD_API_KEY", "") or getattr(settings, "nvd_api_key", "")
    return {"apiKey": key} if key else {}


def _extract_cpe_nodes(cve: dict):
    """Flatten a CVE's configurations into a list of CPE match dicts with the
    fields we need: criteria (cpe string), vulnerable flag, version bounds."""
    nodes = []
    for cfg in cve.get("configurations", []):
        for node in cfg.get("nodes", []):
            for m in node.get("cpeMatch", []):
                if not m.get("vulnerable"):
                    continue
                crit = m.get("criteria", "")
                # criteria like cpe:2.3:o:cisco:ios_xe:16.12.5:*:... -> capture exact version field
                parts = crit.split(":")
                exact = parts[5] if len(parts) > 5 else "*"
                nodes.append({
                    "criteria": crit,
                    "_exact_version": exact,
                    "versionStartIncluding": m.get("versionStartIncluding"),
                    "versionStartExcluding": m.get("versionStartExcluding"),
                    "versionEndIncluding": m.get("versionEndIncluding"),
                    "versionEndExcluding": m.get("versionEndExcluding"),
                })
    return nodes


def _severity_score(cve: dict):
    metrics = cve.get("metrics", {})
    for key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        arr = metrics.get(key)
        if arr:
            data = arr[0].get("cvssData", {})
            score = data.get("baseScore", 0.0)
            sev = data.get("baseSeverity") or arr[0].get("baseSeverity") or ""
            if not sev and key == "cvssMetricV2":
                # V2 has no baseSeverity in cvssData; derive
                sev = ("HIGH" if score >= 7 else "MEDIUM" if score >= 4 else "LOW")
            return float(score), sev.upper()
    return 0.0, ""


async def sync_nvd(days_back: int = 2, full: bool = False) -> dict:
    """Incrementally pull CVEs modified in the last `days_back` days into the
    local table. NVD is rate-limited and flaky, so we page politely with retries
    and backoff. `full` is intended for an initial seed (longer window).
    Returns a summary dict."""
    now = dt.datetime.utcnow()
    start = now - dt.timedelta(days=(120 if full else days_back))
    headers = _nvd_headers()
    delay = 0.7 if headers else 6.5     # NVD: ~0.6s w/ key, ~6s without
    page = 2000
    idx = 0
    fetched = 0
    upserted = 0
    # NVD requires the window <= 120 days; we keep it within that.
    params_base = {
        "lastModStartDate": start.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "lastModEndDate": now.strftime("%Y-%m-%dT%H:%M:%S.000"),
        "resultsPerPage": page,
    }
    while True:
        params = dict(params_base, startIndex=idx)
        body = None
        for attempt in range(4):
            try:
                r = requests.get(NVD_API, params=params, headers=headers, timeout=40)
                if r.status_code == 200:
                    body = r.json()
                    break
                log.warning("NVD %s (attempt %d) startIndex=%d", r.status_code, attempt + 1, idx)
            except Exception as e:  # noqa: BLE001
                log.warning("NVD request error (attempt %d): %s", attempt + 1, e)
            time.sleep(delay * (attempt + 2))   # backoff
        if body is None:
            log.error("NVD sync giving up at startIndex=%d", idx)
            break

        vulns = body.get("vulnerabilities", [])
        total = body.get("totalResults", 0)
        if not vulns:
            break

        rows = []
        for item in vulns:
            cve = item.get("cve", {})
            cid = cve.get("id")
            if not cid:
                continue
            desc = ""
            for d in cve.get("descriptions", []):
                if d.get("lang") == "en":
                    desc = d.get("value", "")
                    break
            score, sev = _severity_score(cve)
            nodes = _extract_cpe_nodes(cve)
            if not nodes:
                continue   # no CPE applicability -> can't match locally, skip storing
            rows.append({
                "cve_id": cid, "description": desc[:4000], "cvss_score": score,
                "severity": sev, "cpe_json": json.dumps(nodes),
                "published": _parse_dt(cve.get("published")),
                "last_modified": _parse_dt(cve.get("lastModified")),
            })

        # upsert this page
        async with SessionLocal() as s:
            for row in rows:
                existing = await s.get(Cve, row["cve_id"])
                if existing:
                    for k, v in row.items():
                        setattr(existing, k, v)
                else:
                    s.add(Cve(**row))
                upserted += 1
            await s.commit()

        fetched += len(vulns)
        idx += page
        log.info("NVD sync: %d/%d processed (%d stored so far)", fetched, total, upserted)
        if idx >= total:
            break
        time.sleep(delay)

    return {"fetched": fetched, "stored": upserted, "window_start": start.isoformat()}


def _parse_dt(s):
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "").split("+")[0])
    except Exception:  # noqa: BLE001
        return None


# ─────────────────────────── matching / scan ───────────────────────────
async def scan_device(device_id: int) -> dict:
    """Resolve the device's CPE, match it against the local CVE table, and
    persist DeviceCve findings. Returns {ok, cpe, matched, by_severity}."""
    async with SessionLocal() as s:
        dev = await s.get(Device, device_id)
        if not dev:
            return {"ok": False, "error": "device not found"}
        # use stored CPE if the user set one, else derive
        cpe = dev.cpe or derive_cpe(dev)
        if not dev.cpe and cpe:
            dev.cpe = cpe
            await s.commit()

    if not cpe:
        return {"ok": True, "cpe": "", "matched": 0, "by_severity": {},
                "note": "no CPE mapping for this device type — not scanned"}

    parts = cpe.split(":")
    dev_vendor = parts[3] if len(parts) > 3 else ""
    dev_product = parts[4] if len(parts) > 4 else ""
    dev_version = parts[5] if len(parts) > 5 else "*"

    matches = []
    async with SessionLocal() as s:
        # candidate CVEs: cheap pre-filter on the JSON containing the product.
        cves = (await s.execute(
            select(Cve).where(Cve.cpe_json.contains(f":{dev_vendor}:{dev_product}:"))
        )).scalars().all()

        for cve in cves:
            try:
                nodes = json.loads(cve.cpe_json)
            except Exception:  # noqa: BLE001
                continue
            for n in nodes:
                cparts = n["criteria"].split(":")
                if len(cparts) < 6:
                    continue
                if cparts[3] != dev_vendor or cparts[4] != dev_product:
                    continue
                if _in_range(dev_version, n):
                    matches.append((cve, n["criteria"]))
                    break

        # rewrite findings for this device
        await s.execute(delete(DeviceCve).where(DeviceCve.device_id == device_id))
        by_sev = {}
        for cve, crit in matches:
            by_sev[cve.severity] = by_sev.get(cve.severity, 0) + 1
            s.add(DeviceCve(device_id=device_id, cve_id=cve.cve_id,
                            severity=cve.severity, cvss_score=cve.cvss_score,
                            matched_cpe=crit))
        await s.commit()

    return {"ok": True, "cpe": cpe, "matched": len(matches), "by_severity": by_sev}


async def scan_fleet() -> dict:
    async with SessionLocal() as s:
        ids = (await s.execute(select(Device.id))).scalars().all()
    total = 0
    for i in ids:
        r = await scan_device(i)
        total += r.get("matched", 0)
    return {"devices": len(ids), "total_findings": total}


async def fleet_summary() -> list:
    """Per-device finding counts by severity, for the Security view."""
    async with SessionLocal() as s:
        devs = (await s.execute(select(Device))).scalars().all()
        out = []
        for d in devs:
            rows = (await s.execute(
                select(DeviceCve.severity, func.count())
                .where(DeviceCve.device_id == d.id)
                .group_by(DeviceCve.severity)
            )).all()
            counts = {sev: n for sev, n in rows}
            out.append({
                "id": d.id, "name": d.name, "ip": d.ip, "type": d.device_type,
                "cpe": d.cpe or derive_cpe(d),
                "critical": counts.get("CRITICAL", 0), "high": counts.get("HIGH", 0),
                "medium": counts.get("MEDIUM", 0), "low": counts.get("LOW", 0),
                "total": sum(counts.values()),
            })
    return out


async def device_findings(device_id: int) -> list:
    """Detailed CVE list for one device, newest/most-severe first."""
    _ORDER = {"CRITICAL": 0, "HIGH": 1, "MEDIUM": 2, "LOW": 3, "": 4}
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(DeviceCve).where(DeviceCve.device_id == device_id)
        )).scalars().all()
        out = []
        for r in rows:
            cve = await s.get(Cve, r.cve_id)
            out.append({
                "cve_id": r.cve_id, "severity": r.severity, "cvss_score": r.cvss_score,
                "matched_cpe": r.matched_cpe, "acknowledged": r.acknowledged,
                "description": (cve.description if cve else ""),
                "published": (cve.published.isoformat() + "Z" if cve and cve.published else None),
                "url": f"https://nvd.nist.gov/vuln/detail/{r.cve_id}",
            })
    out.sort(key=lambda x: (_ORDER.get(x["severity"], 5), -x["cvss_score"]))
    return out


async def cve_counts_for_alerts(device_id: int) -> dict:
    """Expose per-severity CVE counts as metrics the alert engine can target
    (e.g. a custom rule 'cve_critical > 0')."""
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(DeviceCve.severity, func.count())
            .where(DeviceCve.device_id == device_id)
            .group_by(DeviceCve.severity)
        )).all()
    counts = {sev: n for sev, n in rows}
    return {
        "cve_critical": counts.get("CRITICAL", 0),
        "cve_high": counts.get("HIGH", 0),
        "cve_total": sum(counts.values()),
    }
