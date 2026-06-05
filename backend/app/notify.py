"""
Notification channels. Each takes a fired alert and a channel config dict.

Kinds: email (SMTP), webhook (generic JSON POST — Slack/Teams compatible),
syslog (RFC3164 UDP), discord (webhook with embed). All failures are swallowed
and logged so one bad channel never blocks the others.
"""
import json
import logging
import asyncio

log = logging.getLogger("notify")

SEVERITY_RANK = {"info": 0, "warning": 1, "critical": 2}
SEVERITY_COLOR = {"info": 0x3B82F6, "warning": 0xE3B341, "critical": 0xF85149}


async def dispatch(channels, alert: dict):
    """Send one alert to every enabled channel in `channels`. Severity-based
    routing is no longer done here — callers (now the automation engine) decide
    which channels to pass in, so routing lives with the automation that knows
    the context."""
    for ch in channels:
        if not ch.enabled:
            continue
        try:
            cfg = json.loads(ch.config_json or "{}")
        except ValueError:
            cfg = {}
        try:
            await asyncio.to_thread(_send, ch.kind, cfg, alert)
        except Exception as e:  # noqa: BLE001
            log.warning("channel %s (%s) failed: %s", ch.name, ch.kind, e)


def _send(kind, cfg, alert):
    if kind == "email":
        _email(cfg, alert)
    elif kind == "webhook":
        _webhook(cfg, alert)
    elif kind == "syslog":
        _syslog(cfg, alert)
    elif kind == "discord":
        _discord(cfg, alert)


def _line(alert):
    return f"[{alert['severity'].upper()}] {alert['title']} — {alert.get('detail','')}"


# ── email (SMTP) ──
def _email(cfg, alert):
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["Subject"] = f"[SwitchDex {alert['severity'].upper()}] {alert['title']}"
    msg["From"] = cfg.get("from", "switchdex@localhost")
    msg["To"] = cfg.get("to", "")
    msg.set_content(f"{alert['title']}\n\n{alert.get('detail','')}\n\nSeverity: {alert['severity']}\nDevice: {alert.get('device','-')}\nTime: {alert.get('time','')}")
    host = cfg.get("host", "localhost"); port = int(cfg.get("port", 587))
    with smtplib.SMTP(host, port, timeout=10) as s:
        if cfg.get("tls", True):
            s.starttls()
        if cfg.get("username"):
            s.login(cfg["username"], cfg.get("password", ""))
        s.send_message(msg)


# ── generic webhook (Slack/Teams/anything that takes JSON) ──
def _webhook(cfg, alert):
    import requests
    url = cfg["url"]
    # Slack/Teams both accept a "text" field; include structured data too.
    payload = {"text": _line(alert),
               "severity": alert["severity"], "title": alert["title"],
               "detail": alert.get("detail", ""), "device": alert.get("device", ""),
               "time": alert.get("time", "")}
    requests.post(url, json=payload, timeout=10).raise_for_status()


# ── syslog (RFC3164 over UDP) ──
def _syslog(cfg, alert):
    import socket
    host = cfg.get("host", "127.0.0.1"); port = int(cfg.get("port", 514))
    # facility local0 (16); severity map → syslog level
    sev = {"critical": 2, "warning": 4, "info": 6}.get(alert["severity"], 5)
    pri = 16 * 8 + sev
    msg = f"<{pri}>SwitchDex: {_line(alert)}"
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.sendto(msg.encode(), (host, port))
    finally:
        sock.close()


# ── Discord webhook (rich embed) ──
def _discord(cfg, alert):
    import requests
    url = cfg["url"]
    embed = {
        "title": alert["title"],
        "description": alert.get("detail", ""),
        "color": SEVERITY_COLOR.get(alert["severity"], 0x8B949E),
        "fields": [
            {"name": "Severity", "value": alert["severity"], "inline": True},
            {"name": "Device", "value": alert.get("device", "-"), "inline": True},
        ],
        "footer": {"text": f"SwitchDex · {alert.get('time','')}"},
    }
    requests.post(url, json={"embeds": [embed]}, timeout=10).raise_for_status()


# ── test a single channel config (used by the UI's "Test" button) ──
def test_channel(kind, cfg) -> dict:
    sample = {"severity": "info", "title": "SwitchDex test notification",
              "detail": "If you can read this, the channel works.",
              "device": "test-device", "time": "now"}
    try:
        _send(kind, cfg, sample)
        return {"ok": True, "message": "Test notification sent"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}
