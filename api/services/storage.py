"""Supabase Storage 的 REST 客户端。

为什么不用 supabase-py：只需要 5 个操作（上传/下载/删除/列举/签名），
直接用 httpx 打 REST 接口更轻，也少一层版本耦合。

凭据是 service key —— 私有桶没有面向普通用户的策略，
能不能读写在调用方（repositories/routers）已经判定过了。
"""

from typing import Any

import httpx
from fastapi import HTTPException

from ..config import Settings
from ..http import make_client

_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = make_client(httpx.Timeout(30.0, connect=10.0))
    return _client


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _base(settings: Settings) -> str:
    if not settings.supabase_url or not settings.supabase_service_key:
        raise HTTPException(status_code=500, detail="服务端未配置 Supabase，无法读写存储")
    return settings.supabase_url.rstrip("/")


def _object_url(settings: Settings, path: str) -> str:
    return f"{_base(settings)}/storage/v1/object/{settings.storage_bucket}/{path}"


async def upload(settings: Settings, path: str, data: bytes, content_type: str, upsert: bool = False) -> None:
    headers = {
        "Authorization": f"Bearer {settings.supabase_service_key}",
        "Content-Type": content_type,
    }
    if upsert:
        # 断点续传会重传同一片，覆盖比报错再重试省事
        headers["x-upsert"] = "true"

    res = await _http().post(_object_url(settings, path), content=data, headers=headers)
    if res.status_code >= 400:
        raise HTTPException(
            status_code=500,
            detail=f"存储写入失败（{res.status_code}）：{res.text[:200]}",
        )


async def download(settings: Settings, path: str) -> bytes:
    res = await _http().get(
        _object_url(settings, path),
        headers={"Authorization": f"Bearer {settings.supabase_service_key}"},
    )
    if res.status_code == 404:
        raise HTTPException(status_code=404, detail="文件不存在")
    if res.status_code >= 400:
        raise HTTPException(status_code=500, detail=f"存储读取失败（{res.status_code}）")
    return res.content


async def remove(settings: Settings, paths: list[str]) -> None:
    if not paths:
        return
    res = await _http().request(
        "DELETE",
        f"{_base(settings)}/storage/v1/object/{settings.storage_bucket}",
        headers={
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        },
        json={"prefixes": paths},
    )
    # 删除失败不致命（多半是文件本来就不在），记日志由调用方决定
    if res.status_code >= 400:
        from ..log import log_event

        log_event("storage.remove_failed", status=res.status_code, detail=res.text[:200])


async def list_objects(settings: Settings, prefix: str, limit: int = 100) -> list[dict[str, Any]]:
    res = await _http().post(
        f"{_base(settings)}/storage/v1/object/list/{settings.storage_bucket}",
        headers={
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        },
        json={"prefix": prefix, "limit": limit, "offset": 0},
    )
    if res.status_code >= 400:
        return []
    payload = res.json()
    return payload if isinstance(payload, list) else []


async def signed_url(settings: Settings, path: str, expires_in: int = 3600) -> str:
    res = await _http().post(
        f"{_base(settings)}/storage/v1/object/sign/{settings.storage_bucket}/{path}",
        headers={
            "Authorization": f"Bearer {settings.supabase_service_key}",
            "Content-Type": "application/json",
        },
        json={"expiresIn": expires_in},
    )
    if res.status_code >= 400:
        raise HTTPException(status_code=500, detail="生成下载链接失败")
    signed = res.json().get("signedURL", "")
    return f"{_base(settings)}{signed}" if signed.startswith("/") else signed
