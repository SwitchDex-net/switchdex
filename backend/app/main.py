"""FastAPI entrypoint. Initialises the DB and seeds demo devices on first run."""
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI
from sqlalchemy import select, func

from .db import init_db, SessionLocal, Device, User, AuthSettings
from .api import router, ws_router
from .auth_api import router as auth_router
from .integrations import router as integrations_router
from .topology import router as topology_router
from .alerts_api import router as alerts_router
from .compliance_api import router as compliance_router
from .cve_api import router as security_router
from .telemetry_api import router as telemetry_router
from .dashboard_api import router as dashboard_router
from .automations_api import router as automations_router
from . import alerts as alert_engine
from . import auth as A
from . import configstore as store


SEED = [
    dict(name="core-rtr-01", ip="10.0.0.1", vendor="Arista", model="DCS-7050CX3",
         os="EOS 4.28.3M", device_type="router", platform="eos", protocol="NETCONF", location="DC1-Rack-A1", role="core"),
    dict(name="dist-sw-04", ip="10.0.1.4", vendor="Juniper", model="EX4300-48T",
         os="Junos 21.4R3", device_type="switch", platform="junos", protocol="gNMI", location="DC1-Rack-B4", role="distribution"),
    dict(name="core-sw-02", ip="10.0.0.2", vendor="Arista", model="DCS-7060CX-32S",
         os="EOS 4.28.3M", device_type="switch", platform="eos", protocol="NETCONF", location="DC1-Rack-A2", role="core"),
    dict(name="dist-sw-05", ip="10.0.1.5", vendor="Cisco", model="Catalyst 9300",
         os="IOS-XE 17.9.3", device_type="switch", platform="ios", protocol="RESTCONF", location="DC1-Rack-B5", role="distribution"),
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    async with SessionLocal() as s:
        # ── bootstrap local admin (no shipped default credential) ──
        admin_count = (await s.execute(select(func.count(User.id)))).scalar()
        if admin_count == 0:
            pw = secrets.token_urlsafe(12)
            s.add(User(username="admin", password_hash=A.hash_password(pw),
                       role="admin", source="local", must_change_pw=True))
            s.add(AuthSettings(id=1))   # LDAP disabled by default
            await s.commit()
            # printed to container/appliance console so the operator can log in once
            print("=" * 64, flush=True)
            print(" SwitchDex bootstrap admin created", flush=True)
            print("   username: admin", flush=True)
            print(f"   password: {pw}", flush=True)
            print("   (you will be required to change it on first login)", flush=True)
            print("=" * 64, flush=True)

        # ── seed demo devices (off by default; SEED_DEMO_DEVICES=true for eval) ──
        from .config import settings as _cfg
        count = (await s.execute(select(func.count(Device.id)))).scalar()
        if count == 0 and getattr(_cfg, "seed_demo_devices", False):
            for d in SEED:
                s.add(Device(hostname=d["name"], **d))
            await s.commit()
            ids = (await s.execute(select(Device.id))).scalars().all()
            for i in ids:
                await store.backup_device(i, trigger="manual", user="seed")
        await alert_engine.seed_default_rules()

        # ── prime UI-saved NVD API key (survives restarts) ──
        from .db import Setting
        from . import cve as _cve
        nvd_row = await s.get(Setting, "nvd_api_key")
        if nvd_row and nvd_row.value:
            _cve.set_nvd_key_override(nvd_row.value)
    yield


app = FastAPI(title="SwitchDex API", version="2.0", lifespan=lifespan)
app.include_router(auth_router)
app.include_router(router)
app.include_router(ws_router)
app.include_router(integrations_router)
app.include_router(topology_router)
app.include_router(alerts_router)
app.include_router(compliance_router)
app.include_router(security_router)
app.include_router(telemetry_router)
app.include_router(dashboard_router)
app.include_router(automations_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
