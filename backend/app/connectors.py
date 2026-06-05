"""
Controller connectors for closed-ecosystem gear.

Both UniFi and Omada invert SwitchDex's per-device model: you authenticate to a
controller, which already polls its managed devices, and you pull aggregate
telemetry from its API. Each connector exposes a uniform shape:

    login()              -> establish a session / token
    list_devices()       -> [normalized device dicts]
    device_metrics(ext)  -> {cpu, mem, uptime, ports, clients, ...}

Normalized device dict keys: external_id, name, ip, model, os, device_type,
status, source ("unifi"/"omada"), capability ("readonly"/"manage").

Set settings.device_backend="sim" to use the built-in fakes (no controller
required) so the whole integration is demoable end-to-end.
"""
import asyncio
from .config import settings


# ───────────────────────── public dispatch ─────────────────────────────
async def test_controller(ctrl) -> dict:
    if settings.device_backend == "sim":
        return {"ok": True, "message": f"Reached {ctrl.kind} controller (simulated)"}
    try:
        c = _make(ctrl)
        await asyncio.to_thread(c.login)
        n = len(await asyncio.to_thread(c.list_devices))
        return {"ok": True, "message": f"Connected — {n} devices visible"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}


async def sync_controller(ctrl) -> list[dict]:
    """Return the controller's current device list (normalized)."""
    if settings.device_backend == "sim":
        return _sim_devices(ctrl)
    c = _make(ctrl)
    await asyncio.to_thread(c.login)
    return await asyncio.to_thread(c.list_devices)


async def controller_version(ctrl) -> str:
    """Best-effort fetch of the controller's own software version (for CVE
    scanning). Returns '' if unavailable — never fatal to a poll."""
    if settings.device_backend == "sim":
        return "5.13.30" if ctrl.kind == "omada" else "8.0.28"
    try:
        c = _make(ctrl)
        await asyncio.to_thread(c.login)
        fn = getattr(c, "get_controller_version", None)
        if fn:
            return await asyncio.to_thread(fn) or ""
    except Exception:  # noqa: BLE001
        pass
    return ""


async def fetch_metrics(ctrl, external_id: str) -> dict:
    if settings.device_backend == "sim":
        return _sim_metrics(external_id)
    c = _make(ctrl)
    await asyncio.to_thread(c.login)
    return await asyncio.to_thread(c.device_metrics, external_id)


def _make(ctrl):
    return UniFiConnector(ctrl) if ctrl.kind == "unifi" else OmadaConnector(ctrl)


# ───────────────────────── UniFi (read-only) ───────────────────────────
class UniFiConnector:
    """UniFi Network Controller REST API. Unofficial but stable; read-only here.

    Auth: POST /api/login (classic) or /api/auth/login (UniFi OS) with
    username/password -> session cookie. Data under /api/s/<site>/stat/device.
    """
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self._sess = None

    def login(self):
        import requests
        s = requests.Session()
        s.verify = self.ctrl.verify_tls
        # UniFi OS prefixes the API; try it, fall back to classic.
        for path in ("/api/auth/login", "/api/login"):
            r = s.post(self.ctrl.base_url + path,
                       json={"username": self.ctrl.username, "password": self.ctrl.password},
                       timeout=10)
            if r.ok:
                self._sess = s
                return
        raise RuntimeError("UniFi login failed (check URL/credentials)")

    def _api(self, suffix):
        # UniFi OS routes through /proxy/network; classic does not.
        base = self.ctrl.base_url
        prefix = "/proxy/network" if "/proxy/network" not in base else ""
        return f"{base}{prefix}/api/s/{self.ctrl.site}{suffix}"

    def list_devices(self):
        r = self._sess.get(self._api("/stat/device"), timeout=15)
        r.raise_for_status()
        out = []
        for d in r.json().get("data", []):
            out.append({
                "external_id": d.get("_id") or d.get("mac"),
                "name": d.get("name") or d.get("model") or d.get("mac"),
                "ip": d.get("ip", ""),
                "vendor": "Ubiquiti",
                "model": d.get("model", ""),
                "os": d.get("version", ""),
                "device_type": _unifi_type(d.get("type")),
                "status": "up" if d.get("state") == 1 else "down",
                "source": "unifi",
                "capability": "readonly",
            })
        return out

    def device_metrics(self, ext):
        """Per-device metrics from the Omada Open API. The device list already
        carries cpuUtil/memUtil/uptime, so reuse that endpoint rather than a
        separate (UniFi-style) stat call."""
        site_id = self._resolve_site_id()
        url = f"{self.ctrl.base_url}/openapi/v1/{self._cid}/sites/{site_id}/devices"
        r = self._http.get(url, headers=self._hdr(),
                           params={"page": 1, "pageSize": 100}, timeout=15)
        r.raise_for_status()
        body = r.json().get("result", [])
        rows = body.get("data", body) if isinstance(body, dict) else body
        for d in rows:
            if d.get("mac") == ext:
                return {
                    "cpu": float(d.get("cpuUtil", 0) or 0),
                    "mem": float(d.get("memUtil", 0) or 0),
                    "uptime": _omada_uptime_secs(d.get("uptime", 0)),
                    "clients": d.get("clientNum", 0) or d.get("clientNumber", 0) or 0,
                    "ports": [],
                }
        return {}


def _unifi_type(t):
    return {"usw": "switch", "ugw": "router", "uap": "ap"}.get(t, "switch")


# ───────────────────────── Omada (read-only now, write-capable) ─────────
class OmadaConnector:
    """TP-Link Omada Open API. Official + documented. client_id/secret ->
    bearer token. Write operations are supported by the API and reserved for a
    future managed mode; this connector reads telemetry only for now."""
    def __init__(self, ctrl):
        self.ctrl = ctrl
        self._token = None
        self._cid = ctrl.controller_ident

    def login(self):
        import requests
        self._http = requests.Session()
        self._http.verify = self.ctrl.verify_tls
        r = self._http.post(
            f"{self.ctrl.base_url}/openapi/authorize/token?grant_type=client_credentials",
            json={"omadacId": self._cid, "client_id": self.ctrl.client_id,
                  "client_secret": self.ctrl.client_secret},
            timeout=10,
        )
        r.raise_for_status()
        self._token = r.json()["result"]["accessToken"]

    def _hdr(self):
        return {"Authorization": f"AccessToken={self._token}"}

    def get_controller_version(self):
        """Omada controller software version. The plain /api/info endpoint
        (not under /openapi) returns controllerVer without needing the omadacId
        in the path."""
        for path in ("/api/info", f"/openapi/v1/{self._cid}/info"):
            try:
                r = self._http.get(f"{self.ctrl.base_url}{path}",
                                   headers=self._hdr(), timeout=10)
                if r.status_code == 200:
                    res = r.json().get("result", {})
                    ver = res.get("controllerVer") or res.get("version")
                    if ver:
                        return ver
            except Exception:  # noqa: BLE001
                continue
        return ""

    def _resolve_site_id(self):
        """Omada's device endpoints want the opaque siteId, not the site name.
        Look it up from the site list, matching on name (or accept an id if the
        configured 'site' already looks like one)."""
        if getattr(self, "_site_id", None):
            return self._site_id
        # query sites (paginated); match the configured name
        url = f"{self.ctrl.base_url}/openapi/v1/{self._cid}/sites"
        r = self._http.get(url, headers=self._hdr(),
                           params={"page": 1, "pageSize": 100}, timeout=15)
        r.raise_for_status()
        result = r.json().get("result", {})
        sites = result.get("data", result if isinstance(result, list) else [])
        want = (self.ctrl.site or "").strip()
        for st in sites:
            # match by display name, or if the user already entered the id
            if st.get("name") == want or st.get("siteId") == want or st.get("id") == want:
                self._site_id = st.get("siteId") or st.get("id")
                return self._site_id
        # fall back: if exactly one site, use it; else use what was given
        if len(sites) == 1:
            self._site_id = sites[0].get("siteId") or sites[0].get("id")
            return self._site_id
        self._site_id = want
        return self._site_id

    def list_devices(self):
        site_id = self._resolve_site_id()
        url = f"{self.ctrl.base_url}/openapi/v1/{self._cid}/sites/{site_id}/devices"
        r = self._http.get(url, headers=self._hdr(),
                           params={"page": 1, "pageSize": 100}, timeout=15)
        if r.status_code != 200:
            # surface Omada's actual error body (errorCode + msg) instead of a bare 400
            detail = ""
            try:
                j = r.json()
                detail = f" — Omada errorCode={j.get('errorCode')} msg={j.get('msg')!r}"
            except Exception:
                detail = f" — body: {r.text[:300]}"
            raise RuntimeError(f"Omada device list failed: HTTP {r.status_code} at {url}{detail}")
        body = r.json().get("result", [])
        # result may be a bare list or a paginated {data:[...]}
        rows = body.get("data", body) if isinstance(body, dict) else body
        out = []
        for d in rows:
            out.append({
                "external_id": d.get("mac"),
                "name": d.get("name") or d.get("mac"),
                "ip": d.get("ip", ""),
                "vendor": "TP-Link",
                "model": d.get("model", ""),
                "os": d.get("firmwareVersion", ""),
                "device_type": _omada_type(d.get("type")),
                "status": "up" if d.get("status") in (1, "CONNECTED") else "down",
                "source": "omada",
                # Omada Open API supports writes -> eligible for managed mode later
                "capability": "readonly",
            })
        return out

    def device_metrics(self, ext):
        site_id = self._resolve_site_id()
        url = f"{self.ctrl.base_url}/openapi/v1/{self._cid}/sites/{site_id}/devices/{ext}"
        r = self._http.get(url, headers=self._hdr(), timeout=15)
        r.raise_for_status()
        d = r.json().get("result", {})
        return {
            "cpu": float(d.get("cpuUtil", 0) or 0),
            "mem": float(d.get("memUtil", 0) or 0),
            "uptime": d.get("uptime", 0),
            "clients": d.get("clientNum", 0),
            "ports": [{"idx": p.get("port"), "up": p.get("linkStatus") == 1,
                       "speed": p.get("linkSpeed"), "poe": p.get("poe")}
                      for p in d.get("portStats", [])],
        }


def _omada_type(t):
    return {"switch": "switch", "gateway": "router", "ap": "ap"}.get(str(t).lower(), "switch")


def _omada_uptime_secs(v):
    """Omada reports uptime as an int (seconds) or a string like
    '68day(s) 12h 23m 53s'. Normalize to seconds."""
    if isinstance(v, (int, float)):
        return float(v)
    if not v:
        return 0.0
    import re
    s = str(v)
    total = 0.0
    for num, unit in re.findall(r"(\d+)\s*(day|d|h|hour|m|min|s|sec)", s, re.I):
        n = int(num)
        u = unit.lower()
        if u.startswith("day") or u == "d":
            total += n * 86400
        elif u.startswith("h"):
            total += n * 3600
        elif u.startswith("m"):
            total += n * 60
        else:
            total += n
    return total


# ───────────────────────── simulated fallback ──────────────────────────
def _sim_devices(ctrl):
    base = 100 if ctrl.kind == "unifi" else 120
    vendor = "Ubiquiti" if ctrl.kind == "unifi" else "TP-Link"
    models = (["USW-Pro-24-PoE", "U6-Enterprise", "UDM-Pro"] if ctrl.kind == "unifi"
              else ["SG3428MP", "EAP670", "ER7212PC"])
    types = ["switch", "ap", "router"]
    out = []
    for i, (m, t) in enumerate(zip(models, types)):
        out.append({
            "external_id": f"{ctrl.kind}-{ctrl.id}-{i}",
            "name": f"{ctrl.kind}-{t}-{i+1:02d}",
            "ip": f"10.0.9.{base+i}", "vendor": vendor, "model": m,
            "os": "v6.6.55" if ctrl.kind == "unifi" else "1.20.0",
            "device_type": t, "status": "up", "source": ctrl.kind,
            "capability": "readonly",
        })
    return out


def _sim_metrics(ext):
    import random
    return {"cpu": random.randint(5, 40), "mem": random.randint(20, 60),
            "uptime": random.randint(100000, 9000000), "clients": random.randint(0, 48),
            "ports": [{"idx": i, "up": i <= 3, "speed": 1000 if i <= 3 else 0, "poe": 7.4 if i == 1 else 0}
                      for i in range(1, 9)]}
