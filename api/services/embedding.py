"""向量化：调 OpenAI 兼容的 embeddings 接口，外面包一层缓存。

改自 server/utils/embedding.ts，逻辑一致：
  · 先按 `sha256(模型 + 文本)` 查缓存
  · 只把没缓存的送去向量化
  · 回写缓存

缓存表 `embedding_cache` 开了 RLS 但没有策略（只服务端可见），
所以这里必须用 **admin 会话**（BYPASSRLS）读写 —— 用用户会话会一行也读不到。
缓存里只存「文本哈希 + 向量」，不存原文，因此可以全局共用。
"""

from hashlib import sha256

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..http import shared_client
from ..log import log_event
from ..models import EmbeddingCache


def cache_key(model: str, text: str) -> str:
    return sha256(f"{model}:{text}".encode()).hexdigest()


def _as_vector(value: object) -> list[float] | None:
    if isinstance(value, list):
        return [float(x) for x in value]
    if isinstance(value, str):
        body = value.strip().strip("[]")
        return [float(x) for x in body.split(",")] if body else []
    return None


async def embed_texts(admin: AsyncSession, settings: Settings, texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    if not settings.embedding_key:
        raise HTTPException(status_code=500, detail="服务端未配置 NUXT_EMBEDDING_KEY")

    model = settings.embedding_model or "BAAI/bge-m3"
    keys = [cache_key(model, t) for t in texts]
    result: list[list[float] | None] = [None] * len(texts)

    # ---------- 1. 先查缓存 ----------
    if settings.embedding_cache:
        try:
            rows = (
                await admin.execute(
                    select(EmbeddingCache.key, EmbeddingCache.embedding).where(EmbeddingCache.key.in_(keys))
                )
            ).all()
            by_key = {row.key: _as_vector(row.embedding) for row in rows}
            for i, key in enumerate(keys):
                hit = by_key.get(key)
                if hit:
                    result[i] = hit
        except Exception as exc:  # noqa: BLE001 —— 缓存坏了不该影响主流程
            log_event("embedding.cache_read_failed", message=str(exc)[:200])

    missing = [(i, text) for i, text in enumerate(texts) if result[i] is None]

    # ---------- 2. 只把没缓存的送去向量化 ----------
    if missing:
        vectors = await _call_embeddings(settings, model, [text for _, text in missing])
        if len(vectors) != len(missing):
            raise HTTPException(
                status_code=502,
                detail=f"向量数量不匹配：期望 {len(missing)} 条，实际 {len(vectors)} 条",
            )
        for (index, _), vector in zip(missing, vectors, strict=True):
            result[index] = vector

        if settings.embedding_cache:
            try:
                stmt = pg_insert(EmbeddingCache).values(
                    [
                        {"key": keys[index], "model": model, "embedding": vector}
                        for (index, _), vector in zip(missing, vectors, strict=True)
                    ]
                )
                stmt = stmt.on_conflict_do_update(
                    index_elements=["key"],
                    set_={"embedding": stmt.excluded.embedding},
                )
                await admin.execute(stmt)
            except Exception as exc:  # noqa: BLE001
                log_event("embedding.cache_write_failed", message=str(exc)[:200])

    log_event(
        "embedding.done",
        total=len(texts),
        cached=len(texts) - len(missing),
        computed=len(missing),
    )
    return [vector for vector in result if vector is not None]


async def _call_embeddings(settings: Settings, model: str, texts: list[str]) -> list[list[float]]:
    base = settings.embedding_base.rstrip("/")
    res = await shared_client().post(
        f"{base}/embeddings",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {settings.embedding_key.strip()}",
        },
        json={"model": model, "input": texts, "encoding_format": "float"},
    )
    if res.status_code >= 400:
        detail = res.text[:300]
        log_event("embedding.upstream_error", status=res.status_code, detail=detail)
        raise HTTPException(status_code=502, detail=f"向量化接口调用失败：{detail}")

    data = res.json().get("data") or []
    ordered = sorted(data, key=lambda item: item.get("index", 0))
    return [item["embedding"] for item in ordered]
