"""Database layer: async SQLAlchemy engine, ORM models, session helper."""
import datetime as dt

from sqlalchemy import String, Integer, DateTime, Text, ForeignKey, Boolean
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession

from .config import settings

engine = create_async_engine(settings.database_url, echo=False, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


class Base(DeclarativeBase):
    pass


class Device(Base):
    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    hostname: Mapped[str] = mapped_column(String(128))
    ip: Mapped[str] = mapped_column(String(64), unique=True)
    vendor: Mapped[str] = mapped_column(String(64))
    model: Mapped[str] = mapped_column(String(128), default="")
    os: Mapped[str] = mapped_column(String(128), default="")
    device_type: Mapped[str] = mapped_column(String(32), default="switch")
    # NAPALM/Netmiko platform driver name: ios, eos, junos, nxos_ssh, sonic ...
    platform: Mapped[str] = mapped_column(String(32), default="ios")
    protocol: Mapped[str] = mapped_column(String(16), default="SSH")
    location: Mapped[str] = mapped_column(String(128), default="")
    ssh_port: Mapped[int] = mapped_column(Integer, default=22)

    # Per-device credentials (override the global defaults). Stored server-side.
    ssh_username: Mapped[str] = mapped_column(String(64), default="")
    ssh_password: Mapped[str] = mapped_column(String(256), default="")
    snmp_community: Mapped[str] = mapped_column(String(64), default="")

    status: Mapped[str] = mapped_column(String(16), default="up")
    # source: open|unifi|omada|snmp — where this device's data comes from
    source: Mapped[str] = mapped_column(String(16), default="open")
    # capability: manage|readonly — readonly devices hide config/SSH controls
    capability: Mapped[str] = mapped_column(String(16), default="manage")
    controller_id: Mapped[int | None] = mapped_column(ForeignKey("controllers.id"), nullable=True)
    # opaque id of this device within its controller (UniFi _id / Omada mac)
    external_id: Mapped[str] = mapped_column(String(128), default="")
    # LLDP/CDP neighbor hints as JSON string: [{"peer_ip": "...", "local_if": "...", "peer_if": "..."}]
    neighbors_json: Mapped[str] = mapped_column(Text, default="")
    # logical role used for layered topology layout: core | distribution | access | edge
    role: Mapped[str] = mapped_column(String(16), default="access")
    # per-device config-archive settings
    backup_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    backup_interval_hours: Mapped[int] = mapped_column(Integer, default=24)
    last_backup_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    # CPE for vulnerability matching (auto-derived from vendor/platform/version,
    # user-overridable when our mapping is wrong). Empty = not yet resolved.
    cpe: Mapped[str] = mapped_column(String(256), default="")
    # vulnerability-scan state: covered=True means NVD has records for this
    # product (so 0 findings = genuinely clear); False means NVD has no records
    # for the product at all (0 = "no coverage", not "secure"). None = not scanned.
    cve_covered: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    cve_scanned_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)

    versions: Mapped[list["ConfigVersion"]] = relationship(
        back_populates="device", cascade="all, delete-orphan"
    )


class ConfigVersion(Base):
    """Metadata for one archived running-config snapshot. The config text
    itself lives in the git repo; this row points at the commit."""
    __tablename__ = "config_versions"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"))
    ts: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    commit_sha: Mapped[str] = mapped_column(String(64))
    content_hash: Mapped[str] = mapped_column(String(64))
    lines: Mapped[int] = mapped_column(Integer, default=0)
    bytes_: Mapped[int] = mapped_column("bytes", Integer, default=0)
    trigger: Mapped[str] = mapped_column(String(32), default="manual")  # scheduled|change-detected|manual|restore
    user: Mapped[str] = mapped_column(String(64), default="system")

    device: Mapped[Device] = relationship(back_populates="versions")


class User(Base):
    """Local user account. LDAP users are authenticated live and not stored
    here (except an optional cached shadow row for display)."""
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(128), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256), default="")  # bcrypt; empty for ldap-only
    role: Mapped[str] = mapped_column(String(32), default="admin")        # admin | operator | viewer
    source: Mapped[str] = mapped_column(String(16), default="local")      # local | ldap
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_pw: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class AuthSettings(Base):
    """Singleton row (id=1) holding the LDAP/AD configuration, editable at
    runtime so operators enable directory auth without rebuilding the image."""
    __tablename__ = "auth_settings"

    id: Mapped[int] = mapped_column(primary_key=True, default=1)
    ldap_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    directory_type: Mapped[str] = mapped_column(String(16), default="ad")   # ad | openldap
    server_uri: Mapped[str] = mapped_column(String(256), default="")        # ldaps://dc.example.com:636
    use_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    base_dn: Mapped[str] = mapped_column(String(256), default="")           # DC=example,DC=com
    bind_dn: Mapped[str] = mapped_column(String(256), default="")           # service account for searches
    bind_password: Mapped[str] = mapped_column(String(256), default="")
    user_attr: Mapped[str] = mapped_column(String(64), default="sAMAccountName")  # uid for OpenLDAP
    user_filter: Mapped[str] = mapped_column(String(256), default="")       # extra LDAP filter, optional
    admin_group_dn: Mapped[str] = mapped_column(String(256), default="")    # group -> admin role
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class Controller(Base):
    """A closed-ecosystem controller (UniFi / Omada) that SwitchDex polls for
    read-only telemetry. Devices managed by it are synced into inventory."""
    __tablename__ = "controllers"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))           # unifi | omada
    base_url: Mapped[str] = mapped_column(String(256))      # https://controller:8443
    site: Mapped[str] = mapped_column(String(128), default="default")
    verify_tls: Mapped[bool] = mapped_column(Boolean, default=False)
    # UniFi: username/password (or api_key). Omada: client_id/client_secret + omadac_id.
    username: Mapped[str] = mapped_column(String(128), default="")
    password: Mapped[str] = mapped_column(String(256), default="")
    api_key: Mapped[str] = mapped_column(String(256), default="")
    client_id: Mapped[str] = mapped_column(String(128), default="")
    client_secret: Mapped[str] = mapped_column(String(256), default="")
    controller_ident: Mapped[str] = mapped_column(String(128), default="")  # Omada omadacId
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    poll_interval: Mapped[int] = mapped_column(Integer, default=300)         # seconds
    last_poll: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_status: Mapped[str] = mapped_column(String(32), default="never")    # ok | error: ...
    device_count: Mapped[int] = mapped_column(Integer, default=0)
    controller_version: Mapped[str] = mapped_column(String(64), default="")  # controller SW version, for CVE scan
    cve_json: Mapped[str] = mapped_column(Text, default="")   # cached CVE scan result for the controller software
    cve_scanned_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class AlertRule(Base):
    """A condition evaluated each cycle. Preset rules set `preset`; custom rules
    define metric/operator/threshold directly."""
    __tablename__ = "alert_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # preset key (device_down|cpu_high|mem_high|config_changed|bgp_down|backup_failed)
    # or "custom" for metric/operator/threshold rules
    preset: Mapped[str] = mapped_column(String(32), default="custom")
    metric: Mapped[str] = mapped_column(String(32), default="")     # cpu|mem|status (custom)
    operator: Mapped[str] = mapped_column(String(8), default=">")    # > < >= <= == !=
    threshold: Mapped[float] = mapped_column(default=0)
    # condition must hold this many seconds before firing (debounce / "for 10 min")
    duration: Mapped[int] = mapped_column(Integer, default=0)
    severity: Mapped[str] = mapped_column(String(16), default="warning")  # critical|warning|info
    # optional device scope: empty = all devices; else CSV of device ids
    scope: Mapped[str] = mapped_column(String(256), default="")
    auto_resolve: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class Alert(Base):
    """A fired alert instance with lifecycle open -> acknowledged -> resolved."""
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[int | None] = mapped_column(ForeignKey("alert_rules.id"), nullable=True)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), nullable=True)
    # de-dup key so a still-true condition doesn't spawn duplicates
    dedup_key: Mapped[str] = mapped_column(String(128), index=True)
    severity: Mapped[str] = mapped_column(String(16), default="warning")
    title: Mapped[str] = mapped_column(String(256))
    detail: Mapped[str] = mapped_column(Text, default="")
    state: Mapped[str] = mapped_column(String(16), default="open")  # open|acknowledged|resolved
    opened_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    ack_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    ack_by: Mapped[str] = mapped_column(String(64), default="")
    resolved_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[str] = mapped_column(String(64), default="")  # "auto" or username


class NotifyChannel(Base):
    """A notification destination. `config` holds channel-specific JSON
    (SMTP server/creds, webhook URL, syslog host, Discord webhook)."""
    __tablename__ = "notify_channels"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))   # email|webhook|syslog|discord
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    config_json: Mapped[str] = mapped_column(Text, default="{}")
    # only notify for alerts at or above this severity
    min_severity: Mapped[str] = mapped_column(String(16), default="warning")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class CompliancePolicy(Base):
    """A config-content check applied across devices. `kind`:
      require   — config MUST contain `pattern` (missing = violation)
      forbid    — config MUST NOT contain `pattern` (present = violation)
    `match`: substring | regex. Empty scope = all manageable devices."""
    __tablename__ = "compliance_policies"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(String(256), default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    kind: Mapped[str] = mapped_column(String(16), default="require")   # require | forbid
    pattern: Mapped[str] = mapped_column(Text, default="")
    match: Mapped[str] = mapped_column(String(16), default="substring")  # substring | regex
    severity: Mapped[str] = mapped_column(String(16), default="warning")
    scope: Mapped[str] = mapped_column(String(256), default="")        # CSV device ids, empty=all
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class DeviceBaseline(Base):
    """Pins a config version as the approved 'golden' baseline for a device.
    Drift = current running-config differs from this snapshot."""
    __tablename__ = "device_baselines"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), unique=True)
    version_id: Mapped[int] = mapped_column(ForeignKey("config_versions.id"))
    commit_sha: Mapped[str] = mapped_column(String(64))
    content_hash: Mapped[str] = mapped_column(String(64))
    pinned_by: Mapped[str] = mapped_column(String(64), default="")
    pinned_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)


class Cve(Base):
    """A CVE record synced from the NIST NVD API. We store the fields needed for
    local matching + display: the CPE match criteria (as JSON), CVSS score and
    severity, summary, and dates. Matching is done locally against this table so
    scans are instant and resilient to NVD downtime."""
    __tablename__ = "cves"

    cve_id: Mapped[str] = mapped_column(String(32), primary_key=True)   # e.g. CVE-2024-20356
    description: Mapped[str] = mapped_column(Text, default="")
    cvss_score: Mapped[float] = mapped_column(default=0.0)
    severity: Mapped[str] = mapped_column(String(16), default="")       # CRITICAL|HIGH|MEDIUM|LOW|NONE
    # CPE applicability statements (configurations) as raw JSON; matched locally.
    cpe_json: Mapped[str] = mapped_column(Text, default="[]")
    published: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    last_modified: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True, index=True)


class DeviceCve(Base):
    """A confirmed match: this device's software is affected by this CVE.
    Recomputed on each scan; carries a snapshot of severity/score for fast
    display and so alert rules can count by severity without a join."""
    __tablename__ = "device_cves"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    cve_id: Mapped[str] = mapped_column(String(32), index=True)
    severity: Mapped[str] = mapped_column(String(16), default="")
    cvss_score: Mapped[float] = mapped_column(default=0.0)
    matched_cpe: Mapped[str] = mapped_column(String(256), default="")   # the device CPE that matched
    first_seen: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow)
    acknowledged: Mapped[bool] = mapped_column(Boolean, default=False)  # user can dismiss a finding


class MetricSample(Base):
    """A single time-series datapoint. Kept deliberately simple: one row per
    (device, metric, timestamp). `label` distinguishes per-interface series
    (e.g. metric='ifs_rx', label='Ethernet1'); empty for device-level metrics.
    A retention job prunes raw rows and downsamples older data to hourly."""
    __tablename__ = "metric_samples"

    id: Mapped[int] = mapped_column(primary_key=True)
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"), index=True)
    ts: Mapped[dt.datetime] = mapped_column(DateTime, index=True, default=dt.datetime.utcnow)
    metric: Mapped[str] = mapped_column(String(24), index=True)   # cpu|mem|reachable|if_rx|if_tx
    label: Mapped[str] = mapped_column(String(64), default="")    # interface name for per-if metrics
    value: Mapped[float] = mapped_column(default=0)
    # resolution: "raw" (per sample) or "hourly" (downsampled aggregate)
    resolution: Mapped[str] = mapped_column(String(8), default="raw", index=True)


class Setting(Base):
    """Generic app-wide key/value store (JSON text values). Used for shared,
    org-level settings like the dashboard layout. One row per key."""
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=dt.datetime.utcnow,
                                                    onupdate=dt.datetime.utcnow)


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
