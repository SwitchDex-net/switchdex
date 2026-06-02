"""
Multi-vendor device access.

Two backends, selected by settings.device_backend:

  sim  — no hardware needed. Generates believable running-configs and
         responds to interactive shell input. Lets the appliance boot and
         demo end-to-end with zero devices attached.

  real — talks to live gear:
           • NAPALM   get_config()/get_facts()  (structured, multi-vendor)
           • Netmiko  send_config_set()         (raw CLI push / restore)
           • asyncssh interactive shell          (the WebSocket terminal)

Everything above the driver (API, scheduler, archive) is identical for both,
so flipping DEVICE_BACKEND=real is the only change needed to go to production.
"""
import asyncio
from .config import settings


# ───────────────────────── public API ──────────────────────────────────
async def pull_running_config(dev) -> str:
    """Return the device's full running-config as text."""
    if settings.device_backend == "sim":
        return _sim_running_config(dev)
    return await asyncio.to_thread(_napalm_get_config, dev)


async def push_config(dev, config_text: str) -> None:
    """Replace the device running-config (used by restore). Real mode only."""
    if settings.device_backend == "sim":
        return
    await asyncio.to_thread(_napalm_replace_config, dev, config_text)


async def probe(ip: str, *, snmp_community="", ssh_username="", ssh_password="") -> dict:
    """Discovery probe — identify a device at `ip`. Returns vendor/model/os/platform."""
    if settings.device_backend == "sim":
        return _sim_fingerprint(ip)
    return await asyncio.to_thread(_real_probe, ip, snmp_community, ssh_username, ssh_password)


# ───────────────────────── real backend ────────────────────────────────
def _napalm_get_config(dev):
    from napalm import get_network_driver
    driver = get_network_driver(dev.platform)
    creds = _creds(dev)
    with driver(hostname=dev.ip, username=creds[0], password=creds[1],
                optional_args={"port": dev.ssh_port}) as conn:
        return conn.get_config()["running"]


def _napalm_replace_config(dev, config_text):
    from napalm import get_network_driver
    import tempfile, os
    driver = get_network_driver(dev.platform)
    creds = _creds(dev)
    with driver(hostname=dev.ip, username=creds[0], password=creds[1],
                optional_args={"port": dev.ssh_port}) as conn:
        with tempfile.NamedTemporaryFile("w", suffix=".cfg", delete=False) as f:
            f.write(config_text); path = f.name
        try:
            conn.load_replace_candidate(filename=path)
            conn.commit_config()
        finally:
            os.unlink(path)


def _real_probe(ip, snmp_community, ssh_username, ssh_password):
    """Try SNMP sysDescr first, then SSH banner, to fingerprint the device."""
    community = snmp_community or settings.default_snmp_community
    descr = _snmp_sysdescr(ip, community)
    if descr:
        return _classify(descr, ip)
    # Fall back to an SSH connect + 'show version'-ish banner grab via Netmiko
    from netmiko import ConnectHandler
    user = ssh_username or settings.default_ssh_username
    pw = ssh_password or settings.default_ssh_password
    try:
        conn = ConnectHandler(device_type="autodetect", host=ip, username=user, password=pw)
        platform = conn.autodetect() or "ios"
        conn.disconnect()
        return {"vendor": "Unknown", "model": "", "os": "", "platform": platform,
                "device_type": "switch", "reachable": True}
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "error": str(e)}


def _snmp_sysdescr(ip, community):
    try:
        from pysnmp.hlapi import (getCmd, SnmpEngine, CommunityData, UdpTransportTarget,
                                  ContextData, ObjectType, ObjectIdentity)
        it = getCmd(SnmpEngine(), CommunityData(community),
                    UdpTransportTarget((ip, 161), timeout=2, retries=1),
                    ContextData(), ObjectType(ObjectIdentity("1.3.6.1.2.1.1.1.0")))
        errInd, errStat, _, binds = next(it)
        if errInd or errStat:
            return None
        return str(binds[0][1])
    except Exception:  # noqa: BLE001
        return None


def _classify(sysdescr, ip):
    s = sysdescr.lower()
    table = [
        ("arista", ("Arista", "eos")), ("cisco ios-xe", ("Cisco", "ios")),
        ("cisco nx-os", ("Cisco", "nxos_ssh")), ("cisco", ("Cisco", "ios")),
        ("juniper", ("Juniper", "junos")), ("sonic", ("SONiC", "sonic")),
        ("freebsd", ("pfSense", "linux")),
    ]
    for key, (vendor, platform) in table:
        if key in s:
            return {"vendor": vendor, "platform": platform, "model": "", "os": sysdescr[:60],
                    "device_type": "switch", "reachable": True, "sysdescr": sysdescr}
    return {"vendor": "Unknown", "platform": "ios", "model": "", "os": sysdescr[:60],
            "device_type": "switch", "reachable": True, "sysdescr": sysdescr}


def _creds(dev):
    return (dev.ssh_username or settings.default_ssh_username,
            dev.ssh_password or settings.default_ssh_password)


# ───────────────────────── simulated backend ───────────────────────────
_SIM_VENDORS = [
    {"vendor": "Arista", "model": "DCS-7050CX3", "os": "EOS 4.28.3M", "platform": "eos", "device_type": "switch"},
    {"vendor": "Cisco", "model": "Catalyst 9300", "os": "IOS-XE 17.9.3", "platform": "ios", "device_type": "switch"},
    {"vendor": "Juniper", "model": "EX4300-48T", "os": "Junos 21.4R3", "platform": "junos", "device_type": "switch"},
    {"vendor": "SONiC", "model": "AS9516-32D", "os": "SONiC 202205", "platform": "sonic", "device_type": "switch"},
]


def _sim_fingerprint(ip):
    seed = sum(int(o) for o in ip.split(".") if o.isdigit()) % len(_SIM_VENDORS)
    fp = dict(_SIM_VENDORS[seed])
    fp.update(reachable=True, sysdescr=f"{fp['vendor']} {fp['model']} {fp['os']}")
    return fp


def _sim_running_config(dev):
    return "\n".join([
        f"! Running configuration of {dev.hostname}",
        f"! {dev.vendor} {dev.model} — {dev.os}",
        "!", f"version {dev.os}", "!", f"hostname {dev.hostname}", "!", "ip routing",
        "!", f"snmp-server community {dev.snmp_community or settings.default_snmp_community} RO",
        "!", "interface Management0", f" ip address {dev.ip} 255.255.255.0", " no shutdown",
        "!", "interface Ethernet1", " switchport mode access", " switchport access vlan 100", " no shutdown",
        "!", "interface Ethernet2", " switchport mode trunk", " no shutdown",
        "!", "line vty 0 4", " transport input ssh", " login local", "!", "end",
    ])
