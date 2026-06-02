"""
Authentication & authorization.

Login flow (when LDAP is enabled): try the directory first, fall back to the
local account on failure or if the directory is unreachable. This keeps a
break-glass local admin usable even when AD/LDAP is down.

Authorization: an LDAP user landing in the configured admin group gets the
`admin` role; otherwise `viewer`. Local users carry their stored role.

Supports both Active Directory (sAMAccountName/UPN bind) and generic OpenLDAP
(uid + search-then-bind), selected by AuthSettings.directory_type.
"""
import datetime as dt

import bcrypt
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select

from .config import settings
from .db import SessionLocal, User, AuthSettings

oauth2 = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


# ───────────────────────── password hashing ────────────────────────────
def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()


def verify_password(pw: str, pw_hash: str) -> bool:
    if not pw_hash:
        return False
    try:
        return bcrypt.checkpw(pw.encode(), pw_hash.encode())
    except ValueError:
        return False


# ───────────────────────── JWT ─────────────────────────────────────────
def issue_token(username: str, role: str, source: str) -> str:
    now = dt.datetime.utcnow()
    payload = {
        "sub": username, "role": role, "src": source,
        "iat": now, "exp": now + dt.timedelta(hours=settings.token_ttl_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_alg)


def decode_token(token: str) -> dict:
    return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_alg])


# ───────────────────────── login resolution ────────────────────────────
async def authenticate(username: str, password: str) -> dict | None:
    """Return {username, role, source} on success, else None.
    LDAP first (if enabled), then local fallback."""
    async with SessionLocal() as s:
        auth = await s.get(AuthSettings, 1)

    if auth and auth.ldap_enabled:
        res = _ldap_authenticate(auth, username, password)
        if res:                      # directory accepted -> done
            return res
        # directory rejected or unreachable -> fall through to local

    return await _local_authenticate(username, password)


async def _local_authenticate(username, password):
    async with SessionLocal() as s:
        user = (await s.execute(
            select(User).where(User.username == username, User.source == "local")
        )).scalar_one_or_none()
        if user and user.enabled and verify_password(password, user.password_hash):
            return {"username": user.username, "role": user.role, "source": "local",
                    "must_change_pw": user.must_change_pw}
    return None


def _ldap_authenticate(auth: AuthSettings, username, password):
    """Bind to the directory as the user; map admin group -> admin role.
    Returns dict or None. Never raises on a down server (returns None)."""
    if not password:
        return None
    try:
        from ldap3 import Server, Connection, Tls, ALL, SUBTREE
        import ssl

        tls = Tls(validate=ssl.CERT_NONE) if auth.use_tls else None
        server = Server(auth.server_uri, use_ssl=auth.use_tls, tls=tls, get_info=ALL)

        # Resolve the user's DN (and group membership) via a service-account search,
        # then bind as the user to verify the password.
        search_conn = Connection(
            server,
            user=auth.bind_dn or None,
            password=auth.bind_password or None,
            auto_bind=True,
        )

        if auth.directory_type == "ad":
            user_filter = f"(&(objectClass=user)({auth.user_attr}={username})"
        else:  # openldap
            user_filter = f"(&(objectClass=inetOrgPerson)({auth.user_attr}={username})"
        user_filter += (auth.user_filter or "") + ")"

        search_conn.search(
            auth.base_dn, user_filter, search_scope=SUBTREE,
            attributes=["distinguishedName", "memberOf", "dn"],
        )
        if not search_conn.entries:
            return None
        entry = search_conn.entries[0]
        user_dn = str(entry.entry_dn)

        # Verify the password by binding as the user
        user_conn = Connection(server, user=user_dn, password=password)
        if not user_conn.bind():
            return None  # bad password

        # Authorization: admin group membership -> admin, else viewer
        role = "viewer"
        if auth.admin_group_dn:
            groups = []
            if "memberOf" in entry:
                groups = [str(g) for g in entry["memberOf"].values]
            if auth.admin_group_dn.lower() in [g.lower() for g in groups]:
                role = "admin"

        user_conn.unbind()
        search_conn.unbind()
        return {"username": username, "role": role, "source": "ldap", "must_change_pw": False}
    except Exception:  # noqa: BLE001 — server down/misconfig -> fall back to local
        return None


# ───────────────────────── FastAPI dependencies ────────────────────────
async def get_current_user(token: str = Depends(oauth2)) -> dict:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = decode_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    return {"username": payload["sub"], "role": payload.get("role", "viewer"),
            "source": payload.get("src", "local")}


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Admin role required")
    return user


def user_from_token_str(token: str) -> dict | None:
    """For the WebSocket route, which can't use Depends easily."""
    try:
        p = decode_token(token)
        return {"username": p["sub"], "role": p.get("role", "viewer")}
    except jwt.PyJWTError:
        return None
