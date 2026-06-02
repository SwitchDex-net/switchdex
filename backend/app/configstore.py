"""
Git-backed config archive.

Each device gets a file `<device-id>_<hostname>.cfg` in a local git repo.
A backup pulls the running-config, hashes it, and commits only when the
content changed (change detection). Diffs and restores are git operations.
"""
import os
import hashlib
import datetime as dt

from git import Repo
from sqlalchemy import select

from .config import settings
from .db import SessionLocal, Device, ConfigVersion
from . import devices as drv


def _repo() -> Repo:
    path = settings.config_repo
    os.makedirs(path, exist_ok=True)
    if not os.path.isdir(os.path.join(path, ".git")):
        repo = Repo.init(path)
        # ensure an initial commit exists
        readme = os.path.join(path, "README.md")
        with open(readme, "w") as f:
            f.write("# SwitchDex config archive\nManaged automatically.\n")
        repo.index.add([readme])
        repo.index.commit("init archive")
        return repo
    return Repo(path)


def _device_path(dev) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in dev.hostname)
    return f"{dev.id}_{safe}.cfg"


def content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


async def backup_device(device_id: int, trigger: str = "manual", user: str = "system") -> dict:
    """Pull running-config, store a new version only if it changed."""
    async with SessionLocal() as session:
        dev = await session.get(Device, device_id)
        if not dev:
            return {"ok": False, "error": "device not found"}

        try:
            text = await drv.pull_running_config(dev)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"pull failed: {e}"}

        h = content_hash(text)

        # change detection: compare to most recent stored hash
        last = (await session.execute(
            select(ConfigVersion).where(ConfigVersion.device_id == device_id)
            .order_by(ConfigVersion.ts.desc()).limit(1)
        )).scalar_one_or_none()

        if last and last.content_hash == h and trigger != "restore":
            return {"ok": True, "changed": False, "hash": h}

        # write file + commit
        repo = _repo()
        rel = _device_path(dev)
        abs_path = os.path.join(settings.config_repo, rel)
        with open(abs_path, "w") as f:
            f.write(text)
        repo.index.add([rel])
        msg = f"[{trigger}] {dev.hostname} ({dev.ip}) {h}"
        commit = repo.index.commit(msg)

        ver = ConfigVersion(
            device_id=device_id, ts=dt.datetime.utcnow(), commit_sha=commit.hexsha,
            content_hash=h, lines=text.count("\n") + 1, bytes_=len(text),
            trigger=("change-detected" if last and trigger == "scheduled" else trigger),
            user=user,
        )
        session.add(ver)
        await session.commit()

        # surface the change as an alert/notification (best-effort)
        try:
            from . import alerts as alert_engine
            await alert_engine.raise_config_changed(
                device_id, dev.hostname,
                f"Running-config changed ({h}) — {ver.lines} lines, trigger {trigger}")
        except Exception:  # noqa: BLE001
            pass

        return {"ok": True, "changed": True, "hash": h, "commit": commit.hexsha}


def read_version(commit_sha: str, dev_rel_path: str) -> str:
    """Return the config text at a given commit."""
    repo = _repo()
    try:
        blob = repo.commit(commit_sha).tree / dev_rel_path
        return blob.data_stream.read().decode()
    except Exception:  # noqa: BLE001
        return ""


def diff_versions(sha_a: str, sha_b: str, dev_rel_path: str) -> str:
    """Unified diff between two commits for one device file."""
    repo = _repo()
    return repo.git.diff(sha_a, sha_b, "--", dev_rel_path)


async def restore_device(device_id: int, commit_sha: str, user: str = "system") -> dict:
    """Back up current state, then push the archived config back to the device."""
    async with SessionLocal() as session:
        dev = await session.get(Device, device_id)
        if not dev:
            return {"ok": False, "error": "device not found"}
        rel = _device_path(dev)

    # snapshot current state first
    await backup_device(device_id, trigger="manual", user=user)

    text = read_version(commit_sha, rel)
    if not text:
        return {"ok": False, "error": "version not found in archive"}

    async with SessionLocal() as session:
        dev = await session.get(Device, device_id)
        try:
            await drv.push_config(dev, text)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"push failed: {e}"}

    # record the restore as a new version
    res = await backup_device(device_id, trigger="restore", user=user)
    return {"ok": True, **res}
