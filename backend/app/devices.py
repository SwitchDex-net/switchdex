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


def snmp_metrics(ip, community, version="2c"):
    """Poll device-level health metrics over SNMP. Returns
    {cpu: %, mem: %, uptime: "Nd Nh", uptime_secs: int, reachable: bool}.
    Tries Cisco-specific OIDs first, then generic HOST-RESOURCES-MIB, so it
    degrades gracefully across vendors. Any field that can't be read is left at
    0 rather than failing the whole poll."""
    out = {"cpu": 0.0, "mem": 0.0, "uptime": "—", "uptime_secs": 0, "reachable": False}

    # ── uptime: sysUpTime.0 is universal. With -Ovq, net-snmp may render it as
    # "130:5:51:32.34" (D:H:M:S.cc), "(ticks) 0:02:03" or a bare tick count. ──
    upt = _snmp_get(ip, community, "1.3.6.1.2.1.1.3.0", version)
    if upt is not None:
        out["reachable"] = True
        secs = 0
        s = str(upt).strip()
        try:
            import re as _re
            paren = _re.search(r"\((\d+)\)", s)          # "(108937700) ..."
            if paren:
                secs = int(paren.group(1)) // 100
            elif ":" in s:                                # "130:5:51:32.34" = D:H:M:S
                parts = s.split(":")
                parts[-1] = parts[-1].split(".")[0]       # drop hundredths
                nums = [int(p) for p in parts]
                if len(nums) == 4:
                    d, h, mi, se = nums
                    secs = d*86400 + h*3600 + mi*60 + se
                elif len(nums) == 3:
                    h, mi, se = nums
                    secs = h*3600 + mi*60 + se
            elif s.isdigit():                             # bare ticks
                secs = int(s) // 100
        except Exception:  # noqa: BLE001
            secs = 0
        out["uptime_secs"] = secs
        days, rem = divmod(secs, 86400)
        out["uptime"] = f"{days}d {rem // 3600}h"

    # ── CPU: walk cpmCPUTotal5minRev (index varies by platform, e.g. .19), then
    # cpmCPUTotal5min, then generic hrProcessorLoad. Average across entries. ──
    def _avg_walk(base):
        d = _snmp_walk(ip, community, base, version)
        vals = []
        for v in d.values():
            sv = str(v).strip()
            # snmpwalk -Oqn returns just the value; may be "Gauge32: 2" or "2"
            sv = sv.split(":")[-1].strip() if ":" in sv else sv
            try:
                vals.append(float(sv))
            except ValueError:
                continue
        return (sum(vals) / len(vals)) if vals else None

    cpu = _avg_walk("1.3.6.1.4.1.9.9.109.1.1.1.1.8")      # cpmCPUTotal5minRev
    if cpu is None:
        cpu = _avg_walk("1.3.6.1.4.1.9.9.109.1.1.1.1.5")  # cpmCPUTotal5min (older)
    if cpu is None:
        cpu = _avg_walk("1.3.6.1.2.1.25.3.3.1.2")         # hrProcessorLoad (generic)
    if cpu is not None:
        out["cpu"] = round(cpu, 1)
        out["reachable"] = True

    # ── memory: Cisco ciscoMemoryPool used/free -> %, then hrStorage fallback ──
    used = _snmp_get(ip, community, "1.3.6.1.4.1.9.9.48.1.1.1.5.1", version)
    free = _snmp_get(ip, community, "1.3.6.1.4.1.9.9.48.1.1.1.6.1", version)
    try:
        if used is not None and free is not None:
            u, f = float(used), float(free)
            total = u + f
            if total > 0:
                out["mem"] = round(u / total * 100.0, 1)
                out["reachable"] = True
    except (TypeError, ValueError):
        pass

    return out
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


def _speed_token(sp, mapping):
    return mapping.get(sp)


def _cmds_ios(ifname, cfg):
    """Cisco IOS / IOS-XE / NX-OS, Arista EOS, Brocade FastIron — all use the
    classic 'interface X / switchport ... ' model. Differences are minor."""
    cmds = [f"interface {ifname}"]
    if cfg.get("desc") is not None:
        d = cfg["desc"].strip()
        cmds.append(f"description {d}" if d else "no description")
    mode = cfg.get("mode")
    if mode == "access":
        cmds.append("switchport mode access")
        if cfg.get("vlan"):
            cmds.append(f"switchport access vlan {cfg['vlan']}")
    elif mode == "trunk":
        cmds.append("switchport trunk encapsulation dot1q")
        cmds.append("switchport mode trunk")
    elif mode == "routed":
        cmds.append("no switchport")
        ip = cfg.get("ip", "")
        if ip and "/" in ip:
            addr, bits = ip.split("/")
            cmds.append(f"ip address {addr} {cidrToMask(bits)}")
        elif not ip:
            cmds.append("no ip address")
    sp = cfg.get("speed")
    if sp and sp != "auto":
        tok = _speed_token(sp, {"10M": "10", "100M": "100", "1G": "1000", "10G": "10000", "25G": "25000", "40G": "40000", "100G": "100000"})
        if tok:
            cmds.append(f"speed {tok}")
    elif sp == "auto":
        cmds.append("speed auto")
    if cfg.get("duplex"):
        cmds.append(f"duplex {cfg['duplex']}")
    if "shutdown" in cfg:
        cmds.append("shutdown" if cfg["shutdown"] else "no shutdown")
    return cmds


def _cmds_eos(ifname, cfg):
    """Arista EOS — IOS-like, but trunk doesn't need 'encapsulation dot1q'."""
    cmds = [f"interface {ifname}"]
    if cfg.get("desc") is not None:
        d = cfg["desc"].strip()
        cmds.append(f"description {d}" if d else "no description")
    mode = cfg.get("mode")
    if mode == "access":
        cmds.append("switchport mode access")
        if cfg.get("vlan"):
            cmds.append(f"switchport access vlan {cfg['vlan']}")
    elif mode == "trunk":
        cmds.append("switchport mode trunk")
    elif mode == "routed":
        cmds.append("no switchport")
        ip = cfg.get("ip", "")
        if ip and "/" in ip:
            addr, bits = ip.split("/")
            cmds.append(f"ip address {addr}/{bits}")
        elif not ip:
            cmds.append("no ip address")
    sp = cfg.get("speed")
    if sp and sp != "auto":
        tok = _speed_token(sp, {"10M": "10full", "100M": "100full", "1G": "1000full",
                                "10G": "10gfull", "25G": "25gfull", "40G": "40gfull", "100G": "100gfull"})
        if tok:
            cmds.append(f"speed forced {tok}")
    elif sp == "auto":
        cmds.append("speed auto")
    if "shutdown" in cfg:
        cmds.append("shutdown" if cfg["shutdown"] else "no shutdown")
    return cmds


def _cmds_junos(ifname, cfg):
    """Juniper Junos — completely different model: 'set' statements under
    [edit], applied with commit. We emit set/delete statements; the wrapper
    adds 'configure' and 'commit'. Junos uses unit 0 for L2/L3 family."""
    cmds = []
    if cfg.get("desc") is not None:
        d = cfg["desc"].strip()
        cmds.append(f'set interfaces {ifname} description "{d}"' if d else f"delete interfaces {ifname} description")
    mode = cfg.get("mode")
    if mode == "access":
        cmds.append(f"set interfaces {ifname} unit 0 family ethernet-switching interface-mode access")
        if cfg.get("vlan"):
            cmds.append(f"set interfaces {ifname} unit 0 family ethernet-switching vlan members {cfg['vlan']}")
    elif mode == "trunk":
        cmds.append(f"set interfaces {ifname} unit 0 family ethernet-switching interface-mode trunk")
    elif mode == "routed":
        ip = cfg.get("ip", "")
        if ip and "/" in ip:
            cmds.append(f"set interfaces {ifname} unit 0 family inet address {ip}")
        elif not ip:
            cmds.append(f"delete interfaces {ifname} unit 0 family inet")
    sp = cfg.get("speed")
    if sp and sp != "auto":
        tok = _speed_token(sp, {"10M": "10m", "100M": "100m", "1G": "1g", "10G": "10g", "25G": "25g", "40G": "40g", "100G": "100g"})
        if tok:
            cmds.append(f"set interfaces {ifname} speed {tok}")
    if "shutdown" in cfg:
        cmds.append(f"set interfaces {ifname} disable" if cfg["shutdown"] else f"delete interfaces {ifname} disable")
    return cmds


def _cmds_sonic(ifname, cfg):
    """SONiC — 'config' CLI utility (not a config-session model). Each setting
    is its own 'config interface ...' command. No enclosing config mode."""
    cmds = []
    if cfg.get("desc") is not None:
        d = cfg["desc"].strip()
        cmds.append(f'config interface description {ifname} "{d}"')
    mode = cfg.get("mode")
    if mode == "access" and cfg.get("vlan"):
        cmds.append(f"config vlan member add {cfg['vlan']} {ifname} --untagged")
    elif mode == "trunk" and cfg.get("vlan"):
        cmds.append(f"config vlan member add {cfg['vlan']} {ifname}")
    elif mode == "routed":
        ip = cfg.get("ip", "")
        if ip and "/" in ip:
            cmds.append(f"config interface ip add {ifname} {ip}")
    sp = cfg.get("speed")
    if sp and sp != "auto":
        tok = _speed_token(sp, {"10M": "10", "100M": "100", "1G": "1000", "10G": "10000", "25G": "25000", "40G": "40000", "100G": "100000"})
        if tok:
            cmds.append(f"config interface speed {ifname} {tok}")
    if "shutdown" in cfg:
        cmds.append(f"config interface {'shutdown' if cfg['shutdown'] else 'startup'} {ifname}")
    return cmds


# platform → (body generator, wrapper style)
#   wrapper "ios"   : configure terminal / <body> / end / write memory
#   wrapper "junos" : configure / <body> / commit and-quit
#   wrapper "sonic" : <body> (each line standalone) / config save -y
_PLATFORM_GEN = {
    "ios":      (_cmds_ios,   "ios"),
    "nxos_ssh": (_cmds_ios,   "ios"),
    "nxos":     (_cmds_ios,   "ios"),
    "eos":      (_cmds_eos,   "ios"),
    "brocade":  (_cmds_ios,   "ios"),   # FastIron/ICX is IOS-like
    "fastiron": (_cmds_ios,   "ios"),
    "junos":    (_cmds_junos, "junos"),
    "sonic":    (_cmds_sonic, "sonic"),
}


def build_interface_commands(ifname, cfg, platform="ios"):
    """Translate a desired interface config into CLI commands for the device's
    platform. Returns the body command lines (no enclosing config-mode wrappers).
    Falls back to IOS syntax for unknown platforms."""
    gen, _ = _PLATFORM_GEN.get((platform or "ios").lower(), (_cmds_ios, "ios"))
    return gen(ifname, cfg)


def wrap_commands(body, platform="ios"):
    """Wrap body commands in the platform's config-entry/commit/save sequence.
    Returns the full command list to send over the SSH shell."""
    _, style = _PLATFORM_GEN.get((platform or "ios").lower(), (_cmds_ios, "ios"))
    if style == "junos":
        return ["configure"] + body + ["commit and-quit"]
    if style == "sonic":
        return body + ["config save -y"]
    # ios-style default
    return ["configure terminal"] + body + ["end", "write memory"]




def preview_interface_commands(ifname, cfg, platform="ios"):
    """Full command sequence (with config-mode wrappers) as text, for the
    confirm-before-apply preview."""
    body = build_interface_commands(ifname, cfg, platform)
    return "configure terminal\n " + "\n ".join(body) + "\nend\nwrite memory"


def apply_interface_config(ip, port, user, pw, ifname, cfg, platform="ios"):
    """Push interface config over SSH (asyncssh shell — same path as the working
    terminal). Returns {ok, output, verify, commands, errors}. Never raises;
    errors come back in the dict so the UI shows the device's actual response."""
    import asyncio as _aio
    import asyncssh

    LEGACY_KEX = ["diffie-hellman-group14-sha1", "diffie-hellman-group-exchange-sha1",
                  "diffie-hellman-group14-sha256", "curve25519-sha256",
                  "ecdh-sha2-nistp256", "diffie-hellman-group16-sha512"]
    LEGACY_HKEY = ["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512", "ssh-ed25519",
                   "ecdsa-sha2-nistp256"]
    body = build_interface_commands(ifname, cfg, platform)
    sequence = wrap_commands(body, platform)
    style = _PLATFORM_GEN.get((platform or "ios").lower(), (_cmds_ios, "ios"))[1]
    # platform-specific no-paging + verify commands
    pager_off = {"ios": "terminal length 0", "junos": "set cli screen-length 0",
                 "sonic": ""}.get(style, "terminal length 0")
    verify_cmd = {"ios": f"show running-config interface {ifname}",
                  "junos": f"show configuration interfaces {ifname}",
                  "sonic": f"show interfaces status {ifname}"}.get(style,
                  f"show running-config interface {ifname}")

    async def _drain(proc, timeout=1.0):
        buf = ""
        try:
            while True:
                chunk = await _aio.wait_for(proc.stdout.read(4096), timeout=timeout)
                if not chunk:
                    break
                buf += chunk
        except _aio.TimeoutError:
            pass
        return buf

    async def _go():
        async with asyncssh.connect(ip, port=port, username=user, password=pw,
                                    known_hosts=None, kex_algs=LEGACY_KEX,
                                    server_host_key_algs=LEGACY_HKEY,
                                    connect_timeout=8) as conn:
            proc = await conn.create_process(term_type="vt100", encoding="utf-8")
            if pager_off:
                proc.stdin.write(pager_off + "\n")
                await _aio.sleep(0.3)
                await _drain(proc, 0.5)
            for line in sequence:
                proc.stdin.write(line + "\n")
                await _aio.sleep(0.3)
            collected = await _drain(proc, 1.2)
            proc.stdin.write(verify_cmd + "\n")
            await _aio.sleep(0.6)
            verify = await _drain(proc, 1.0)
            proc.stdin.write("exit\n")
            return collected, verify

    try:
        out, verify = _aio.run(_aio.wait_for(_go(), timeout=35))
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"Config push failed: {e}", "commands": sequence}
    # error detection per platform: IOS/EOS/Brocade prefix errors with '%';
    # Junos says 'error:'/'syntax error'; SONiC prints 'Error'/'Usage'.
    low = out.lower()
    if style == "junos":
        err_lines = [ln for ln in out.splitlines() if "error" in ln.lower() or "unknown command" in ln.lower()]
    elif style == "sonic":
        err_lines = [ln for ln in out.splitlines() if ln.strip().lower().startswith(("error", "usage:")) or "no such" in ln.lower()]
    else:
        err_lines = [ln for ln in out.splitlines() if ln.strip().startswith("%")]
    return {"ok": not err_lines, "output": out, "verify": verify,
            "commands": sequence, "errors": err_lines}


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
        fp = _classify(descr, ip)
        # Pull operator-set metadata so the form can pre-fill instead of "Unknown".
        sysname = _snmp_get(ip, community, "1.3.6.1.2.1.1.5.0")      # sysName
        syslocation = _snmp_get(ip, community, "1.3.6.1.2.1.1.6.0")  # sysLocation
        if sysname:
            fp["hostname"] = sysname
        if syslocation:
            fp["location"] = syslocation
        return fp
    if not user:
        return {"reachable": False, "error": "SNMP returned nothing and no SSH username configured."}
    return _ssh_probe(ip, 22, user, pw)


def _snmp_get(ip, community, oid, version="2c"):
    """Fetch a single SNMP OID value via the net-snmp `snmpget` binary.

    We shell out to `snmpget` rather than use pysnmp's HLAPI: pysnmp removed the
    synchronous getCmd in 6.2 and its API has churned repeatedly across 6.x/7.x,
    so binding discovery to it is fragile. The net-snmp CLI is stable and present
    in the image (see backend/Dockerfile). Returns the value string or None.
    """
    import subprocess
    try:
        # -Ovq: value only, no type prefix, no quotes; -t/-r: timeout/retries
        out = subprocess.run(
            ["snmpget", "-v", version, "-c", community, "-Ovq", "-t", "2", "-r", "1",
             f"{ip}:161", oid],
            capture_output=True, text=True, timeout=10,
        )
        if out.returncode == 0 and out.stdout.strip():
            val = out.stdout.strip().strip('"')
            # snmpget returns these literals when an OID has no value
            if val in ("", "No Such Object available on this agent at this OID",
                       "No Such Instance currently exists at this OID"):
                return None
            return val
        return None
    except Exception:  # noqa: BLE001 — binary missing, timeout, etc.
        return None


def _snmp_sysdescr(ip, community, version="2c"):
    """Fetch sysDescr.0 (1.3.6.1.2.1.1.1.0)."""
    return _snmp_get(ip, community, "1.3.6.1.2.1.1.1.0", version)


def _classify(sysdescr, ip):
    s = sysdescr.lower()
    table = [
        ("arista", ("Arista", "eos")), ("cisco ios-xe", ("Cisco", "ios")),
        ("cisco nx-os", ("Cisco", "nxos_ssh")), ("cisco", ("Cisco", "ios")),
        ("juniper", ("Juniper", "junos")), ("sonic", ("SONiC", "sonic")),
        ("brocade", ("Brocade", "brocade")), ("foundry", ("Brocade", "brocade")),
        ("ruckus", ("Brocade", "brocade")), ("ironware", ("Brocade", "brocade")),
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
