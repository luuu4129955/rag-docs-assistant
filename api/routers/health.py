"""运维接口：只报告「配置了没有」和「数据库通不通」，绝不回显任何密钥的值。

口径对齐现有 TS 版的 /api/health，另外加了数据库连通性一节。
"""

from urllib.parse import urlsplit

from fastapi import APIRouter

from .. import db
from ..config import get_settings

router = APIRouter(tags=["ops"])


def _host(value: str) -> str | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        return urlsplit(raw).hostname
    except Exception:
        return None


@router.get("/health")
async def health() -> dict:
    settings = get_settings()
    database = await db.check_connectivity("app")

    return {
        # Supabase
        "supabaseUrl": bool(settings.supabase_url),
        "supabaseHost": _host(settings.supabase_url),
        "supabaseServiceKey": bool(settings.supabase_service_key),
        "supabaseDbUrl": bool(settings.db_url),
        # 聊天模型
        "chatKey": bool(settings.chat_key_resolved),
        "chatBaseHost": _host(settings.chat_base),
        "chatModel": settings.chat_model,
        # 向量化与检索
        "embeddingKey": bool(settings.embedding_key),
        "embeddingModel": settings.embedding_model,
        "ragTopK": settings.rag_top_k,
        "ragThreshold": settings.rag_threshold,
        # 数据库（直连）连通性
        "database": database,
    }
