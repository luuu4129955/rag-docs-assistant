"""鉴权路由：注册 / 登录 / 刷新 / 退出 / 当前用户。

和 TS 版一样，**登录由服务端代理**，浏览器里不放任何 Supabase 密钥 ——
前端只拿我们转发的 access/refresh token。

直接用 Supabase Auth 的 REST 接口（GoTrue），不引 supabase-py：
只有 5 个调用，多一层 SDK 不如少一层版本耦合。
"""

import re
from typing import Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from ..config import Settings, get_settings
from ..deps import CurrentUser
from ..http import make_client
from ..security import bearer_token

router = APIRouter(prefix="/api/auth", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class Credentials(BaseModel):
    email: str = ""
    password: str = ""


class RefreshBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    refresh_token: str = Field(default="", alias="refreshToken")


def _auth_base(settings: Settings) -> str:
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="服务端未配置 Supabase")
    return f"{settings.supabase_url.rstrip('/')}/auth/v1"


def _headers(settings: Settings, token: str | None = None) -> dict[str, str]:
    return {
        "apikey": settings.supabase_service_key,
        "Authorization": f"Bearer {token or settings.supabase_service_key}",
        "Content-Type": "application/json",
    }


async def _post(
    settings: Settings,
    path: str,
    payload: dict,
    token: str | None = None,
) -> httpx.Response:
    async with make_client(20.0) as client:
        return await client.post(
            f"{_auth_base(settings)}{path}",
            headers=_headers(settings, token),
            json=payload,
        )


def _session_payload(data: dict) -> dict:
    user = data.get("user") or {}
    return {
        "user": {"id": user.get("id"), "email": user.get("email")},
        "session": {
            "accessToken": data.get("access_token"),
            "refreshToken": data.get("refresh_token"),
            "expiresAt": data.get("expires_at"),
        },
    }


@router.post("/login")
async def login(body: Credentials) -> dict:
    settings = get_settings()
    email = body.email.strip().lower()
    if not email or not body.password:
        raise HTTPException(status_code=400, detail="请填写邮箱和密码")

    res = await _post(
        settings,
        "/token?grant_type=password",
        {"email": email, "password": body.password},
    )
    if res.status_code >= 400:
        # 不区分「邮箱不存在」和「密码错误」，避免被人拿来枚举账号
        raise HTTPException(status_code=401, detail="邮箱或密码不正确")
    return _session_payload(res.json())


@router.post("/register")
async def register(body: Credentials) -> dict:
    settings = get_settings()
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="请填写有效邮箱")
    if len(body.password) < 6:
        raise HTTPException(status_code=400, detail="密码至少 6 位")

    res = await _post(settings, "/signup", {"email": email, "password": body.password})
    if res.status_code >= 400:
        detail = res.json().get("msg") or res.text[:200] if res.content else "注册失败"
        raise HTTPException(status_code=400, detail=str(detail))

    data = res.json()
    if data.get("access_token"):
        return {**_session_payload(data), "needsConfirm": False}

    # 没有 session 说明项目开了「Confirm email」，前端要提示去邮箱确认
    user = data.get("user") if isinstance(data.get("user"), dict) else data
    return {
        "user": {"id": user.get("id"), "email": user.get("email")},
        "session": None,
        "needsConfirm": True,
    }


@router.post("/refresh")
async def refresh(body: RefreshBody) -> dict:
    settings = get_settings()
    token = body.refresh_token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="缺少 refreshToken")

    res = await _post(settings, "/token?grant_type=refresh_token", {"refresh_token": token})
    if res.status_code >= 400:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")
    return {"session": _session_payload(res.json())["session"]}


@router.post("/logout")
async def logout(authorization: Annotated[str | None, Header()] = None) -> dict:
    settings = get_settings()
    token = bearer_token(authorization)
    if token:
        try:
            async with make_client(10.0) as client:
                await client.post(f"{_auth_base(settings)}/logout", headers=_headers(settings, token))
        except Exception:  # noqa: BLE001 —— 退出失败不该阻塞前端
            pass
    return {"ok": True}


@router.get("/me")
async def me(user: CurrentUser) -> dict:
    return {"id": str(user.id), "email": user.email}
