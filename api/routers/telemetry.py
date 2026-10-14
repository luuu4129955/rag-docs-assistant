"""前端错误上报入口（轻量版 Sentry）。

浏览器侧的异常（JS 报错、未处理的 Promise、Vue 渲染错误、资源加载失败）
由前端插件收集后批量打到这里，落库到 client_errors。

统一口径：**登录态是可选的** —— 登录接口本身报错时也要能上报。
未登录时按 IP 分桶限流。
"""

from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, Field

from ..config import get_settings
from ..deps import AdminSessionDep
from ..log import log_event
from ..repositories import metrics as repo
from ..security import current_user as resolve_user
from ..services.rate_limit import enforce

router = APIRouter(prefix="/api", tags=["telemetry"])

MAX_EVENTS = 20
MAX_MESSAGE = 500
MAX_STACK = 4000


class TelemetryEvent(BaseModel):
    kind: str = "js"
    message: str = ""
    source: str | None = None
    stack: str | None = None
    url: str | None = None
    meta: dict | None = None


class TelemetryBody(BaseModel):
    events: list[TelemetryEvent] = Field(default_factory=list)


def _clip(value: str | None, limit: int) -> str | None:
    return value[:limit] if value else None


@router.post("/telemetry")
async def ingest(
    body: TelemetryBody,
    request: Request,
    admin: AdminSessionDep,
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    settings = get_settings()

    user_id = None
    if authorization:
        try:
            user_id = (await resolve_user(authorization)).id
        except HTTPException:
            user_id = None

    ip = request.client.host if request.client else "unknown"
    await enforce(admin, settings, str(user_id) if user_id else ip, "telemetry")

    user_agent = (request.headers.get("user-agent") or "")[:300]
    rows = [
        {
            "user_id": user_id,
            "kind": (event.kind or "js")[:24],
            "message": event.message[:MAX_MESSAGE],
            "source": _clip(event.source, 300),
            "stack": _clip(event.stack, MAX_STACK),
            "url": _clip(event.url, 500),
            "user_agent": user_agent,
            "meta": event.meta,
        }
        for event in body.events[:MAX_EVENTS]
        if event.message.strip()
    ]
    if not rows:
        return {"ok": True, "accepted": 0}

    try:
        accepted = await repo.insert_client_errors(admin, rows)
    except Exception as exc:  # noqa: BLE001 —— 迁移没跑时别把上报也变成新错误
        log_event("telemetry.write_failed", message=str(exc)[:200])
        return {"ok": False, "accepted": 0}

    for row in rows:
        log_event(
            "client_error",
            userId=str(user_id) if user_id else None,
            kind=row["kind"],
            message=row["message"],
        )

    return {"ok": True, "accepted": accepted}
