"""Auth endpoints: login, current-user, local-user management, LDAP config."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlalchemy import select

from .db import SessionLocal, User, AuthSettings
from . import auth as A

router = APIRouter(prefix="/api/auth")


# ───────────────────────── login / me ──────────────────────────────────
@router.post("/login")
async def login(form: OAuth2PasswordRequestForm = Depends()):
    res = await A.authenticate(form.username, form.password)
    if not res:
        raise HTTPException(401, "Invalid credentials")
    token = A.issue_token(res["username"], res["role"], res["source"])
    return {"access_token": token, "token_type": "bearer",
            "user": {"username": res["username"], "role": res["role"], "source": res["source"]},
            "must_change_pw": res.get("must_change_pw", False)}


@router.get("/me")
async def me(user: dict = Depends(A.get_current_user)):
    return user


class ChangePw(BaseModel):
    old_password: str
    new_password: str


@router.post("/change-password")
async def change_password(body: ChangePw, user: dict = Depends(A.get_current_user)):
    if user["source"] != "local":
        raise HTTPException(400, "Directory users change passwords in the directory")
    async with SessionLocal() as s:
        u = (await s.execute(select(User).where(User.username == user["username"]))).scalar_one_or_none()
        if not u or not A.verify_password(body.old_password, u.password_hash):
            raise HTTPException(400, "Current password incorrect")
        u.password_hash = A.hash_password(body.new_password)
        u.must_change_pw = False
        await s.commit()
    return {"ok": True}


# ───────────────────────── local user management (admin) ───────────────
class UserIn(BaseModel):
    username: str
    password: str = ""
    role: str = "operator"


@router.get("/users")
async def list_users(_: dict = Depends(A.require_admin)):
    async with SessionLocal() as s:
        rows = (await s.execute(select(User))).scalars().all()
        return [{"id": u.id, "username": u.username, "role": u.role,
                 "source": u.source, "enabled": u.enabled} for u in rows]


@router.post("/users")
async def create_user(body: UserIn, _: dict = Depends(A.require_admin)):
    async with SessionLocal() as s:
        exists = (await s.execute(select(User).where(User.username == body.username))).scalar_one_or_none()
        if exists:
            raise HTTPException(409, "User already exists")
        u = User(username=body.username, role=body.role, source="local",
                 password_hash=A.hash_password(body.password) if body.password else "")
        s.add(u)
        await s.commit()
    return {"ok": True}


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, admin: dict = Depends(A.require_admin)):
    async with SessionLocal() as s:
        u = await s.get(User, user_id)
        if not u:
            raise HTTPException(404)
        if u.username == admin["username"]:
            raise HTTPException(400, "Cannot delete your own account")
        await s.delete(u)
        await s.commit()
    return {"ok": True}


# ───────────────────────── LDAP configuration (admin) ──────────────────
class LdapIn(BaseModel):
    ldap_enabled: bool = False
    directory_type: str = "ad"          # ad | openldap
    server_uri: str = ""
    use_tls: bool = True
    base_dn: str = ""
    bind_dn: str = ""
    bind_password: str = ""
    user_attr: str = "sAMAccountName"
    user_filter: str = ""
    admin_group_dn: str = ""


@router.get("/ldap")
async def get_ldap(_: dict = Depends(A.require_admin)):
    async with SessionLocal() as s:
        a = await s.get(AuthSettings, 1)
        if not a:
            return LdapIn().model_dump()
        d = {k: getattr(a, k) for k in LdapIn.model_fields}
        d["bind_password"] = "********" if a.bind_password else ""   # never echo the secret
        return d


@router.put("/ldap")
async def set_ldap(body: LdapIn, _: dict = Depends(A.require_admin)):
    async with SessionLocal() as s:
        a = await s.get(AuthSettings, 1)
        if not a:
            a = AuthSettings(id=1)
            s.add(a)
        for k, v in body.model_dump().items():
            if k == "bind_password" and v == "********":
                continue  # keep existing secret if the UI sent the mask back
            setattr(a, k, v)
        await s.commit()
    return {"ok": True}


@router.post("/ldap/test")
async def test_ldap(body: LdapIn, _: dict = Depends(A.require_admin)):
    """Try a service-account bind so the admin can validate config before saving."""
    try:
        from ldap3 import Server, Connection, Tls, ALL
        import ssl
        tls = Tls(validate=ssl.CERT_NONE) if body.use_tls else None
        server = Server(body.server_uri, use_ssl=body.use_tls, tls=tls, get_info=ALL)
        conn = Connection(server, user=body.bind_dn or None,
                          password=body.bind_password or None, auto_bind=True)
        conn.unbind()
        return {"ok": True, "message": "Bind succeeded"}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "message": str(e)}
