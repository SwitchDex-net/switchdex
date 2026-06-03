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


async def probe(ip: str, *, auth="snmpv2", snmp_community="", ssh_username="", ssh_password="") -> dict:
    """Discovery probe — identify a device at `ip`. Returns vendor/model/os/platform.
    `auth` selects the method: snmpv2/snmpv3 → SNMP, ssh → SSH only."""
    if settings.device_backend == "sim":
        return _sim_fingerprint(ip)
    return await asyncio.to_thread(_real_probe, ip, auth, snmp_community, ssh_username, ssh_password)


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


def _snmp_walk(ip, community, oid, version="2c"):
    """snmpwalk an OID subtree -> dict of {index: value}. Index is the trailing
    number of each returned OID (e.g. ifDescr.3 -> key '3')."""
    import subprocess
    out = {}
    try:
        r = subprocess.run(
            ["snmpwalk", "-v", version, "-c", community, "-Oqn", "-t", "2", "-r", "1",
             f"{ip}:161", oid],
            capture_output=True, text=True, timeout=20,
        )
        if r.returncode != 0:
            return out
        for line in r.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            # "-Oqn" → ".1.3.6.1.2.1.2.2.1.2.3 GigabitEthernet1/0/3"
            parts = line.split(None, 1)
            if len(parts) != 2:
                continue
            full_oid, val = parts
            idx = full_oid.rstrip(".").split(".")[-1]
            out[idx] = val.strip().strip('"')
    except Exception:  # noqa: BLE001
        return out
    return out


def snmp_interfaces(ip, community, version="2c"):
    """Enumerate interfaces from the device's IF-MIB via SNMP.
    Returns {ifname: {speed, status, desc, mode, vlan, ip, shutdown, kind}}.
    `kind` is "physical" for real ports (faceplate) or "logical" for SVIs,
    loopbacks, port-channels, tunnels, null, etc."""
    IF_DESCR = "1.3.6.1.2.1.2.2.1.2"      # ifDescr
    IF_TYPE  = "1.3.6.1.2.1.2.2.1.3"      # ifType (IANAifType)
    IF_OPER  = "1.3.6.1.2.1.2.2.1.8"      # ifOperStatus (1=up,2=down)
    IF_SPEED = "1.3.6.1.2.1.2.2.1.5"      # ifSpeed (bps)
    IF_ALIAS = "1.3.6.1.2.1.31.1.1.1.18"  # ifAlias (description)
    descr = _snmp_walk(ip, community, IF_DESCR, version)
    if not descr:
        return {}
    iftype = _snmp_walk(ip, community, IF_TYPE, version)
    oper  = _snmp_walk(ip, community, IF_OPER, version)
    speed = _snmp_walk(ip, community, IF_SPEED, version)
    alias = _snmp_walk(ip, community, IF_ALIAS, version)

    # IANAifType values that are real, physical, panel-worthy ports.
    PHYSICAL_TYPES = {"6", "117"}   # ethernetCsmacd, gigabitEthernet
    # Everything else commonly seen on a switch is logical: 53 propVirtual,
    # 135 l2vlan, 136 l3ipvlan (SVIs), 24 softwareLoopback, 161 ieee8023adLag
    # (port-channel), 1 other/null, 131 tunnel, 53 vlan, etc.

    def fmt_speed(bps):
        try:
            n = int(bps)
        except (TypeError, ValueError):
            return "—"
        for unit, div in (("100G", 100e9), ("40G", 40e9), ("25G", 25e9),
                          ("10G", 10e9), ("1G", 1e9), ("100M", 100e6), ("10M", 10e6)):
            if n >= div:
                return unit
        return f"{n//1_000_000}M" if n else "—"

    out = {}
    for idx, name in descr.items():
        st = oper.get(idx, "2")
        t = iftype.get(idx, "")
        out[name] = {
            "speed": fmt_speed(speed.get(idx)),
            "status": "up" if st == "1" else "down",
            "desc": alias.get(idx, ""),
            "mode": "access", "vlan": None, "ip": "", "shutdown": st != "1",
            "kind": "physical" if t in PHYSICAL_TYPES else "logical",
        }
    return out


def _ssh_probe(ip, port, user, pw):
    """SSH-based fingerprint using asyncssh (same path as the live terminal,
    which handles the legacy algorithms older Cisco gear requires). Runs
    'show version' and classifies the output. Returns a probe dict."""
    import asyncio as _aio
    import asyncssh

    LEGACY_KEX = ["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1",
                  "diffie-hellman-group14-sha256", "curve25519-sha256",
                  "ecdh-sha2-nistp256", "diffie-hellman-group16-sha512"]
    LEGACY_HKEY = ["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512", "ssh-ed25519",
                   "ecdsa-sha2-nistp256"]

    async def _go():
        async with asyncssh.connect(ip, port=port, username=user, password=pw,
                                    known_hosts=None, kex_algs=LEGACY_KEX,
                                    server_host_key_algs=LEGACY_HKEY,
                                    connect_timeout=8) as conn:
            r = await conn.run("show version", check=False, timeout=10)
            return (r.stdout or "") + (r.stderr or "")

    try:
        out = _aio.run(_aio.wait_for(_go(), timeout=15))
    except Exception as e:  # noqa: BLE001
        return {"reachable": False, "error": f"SSH probe failed: {e}"}
    if not out.strip():
        return {"reachable": False, "error": "SSH connected but 'show version' returned nothing."}
    fp = _classify(out, ip)
    fp["reachable"] = True
    return fp


def _real_probe(ip, auth, snmp_community, ssh_username, ssh_password):
    """Identify a device. `auth='ssh'` → SSH only; otherwise SNMP first, then SSH."""
    user = ssh_username or settings.default_ssh_username
    pw = ssh_password or settings.default_ssh_password

    if auth == "ssh":
        if not user:
            return {"reachable": False, "error": "No SSH username provided and no default configured."}
        return _ssh_probe(ip, 22, user, pw)

    # SNMP-first (snmpv2/snmpv3), then fall back to SSH if SNMP is silent.
    community = snmp_community or settings.default_snmp_community
    descr = _snmp_sysdescr(ip, community)
    if descr:
        return _classify(descr, ip)
    if not user:
        return {"reachable": False, "error": "SNMP returned nothing and no SSH username configured."}
    return _ssh_probe(ip, 22, user, pw)


def _snmp_sysdescr(ip, community, version="2c"):
    """Fetch sysDescr.0 via the net-snmp `snmpget` binary.

    We shell out to `snmpget` rather than use pysnmp's HLAPI: pysnmp removed the
    synchronous getCmd in 6.2 and its API has churned repeatedly across 6.x/7.x,
    so binding discovery to it is fragile. The net-snmp CLI is stable and present
    in the image (see backend/Dockerfile). Returns the sysDescr string or None.
    """
    import subprocess
    try:
        # -Ovq: value only, no type prefix, no quotes; -t/-r: timeout/retries
        out = subprocess.run(
            ["snmpget", "-v", version, "-c", community, "-Ovq", "-t", "2", "-r", "1",
             f"{ip}:161", "1.3.6.1.2.1.1.1.0"],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            return out.stdout.strip().strip('"')
        return None
    except Exception:  # noqa: BLE001 — binary missing, timeout, etc.
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
