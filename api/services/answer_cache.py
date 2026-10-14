"""答案缓存。

同一个问题 + 同一份语料 + 同一套参数 → 直接复用上次的回答，
省掉「向量化 + 检索 + 重排 + 模型」这一整条链路。

关键不是「存起来」，而是**失效条件**：
  1) 语料变了（上传/重新分块/重新向量化）→ corpusVersion 变化 → 旧缓存自然失效
  2) 参数变了（换模型、调阈值、调 Top-K）→ 这些参数进缓存键
  3) 时间太久 → TTL（默认 7 天）
三者缺一，就会出现「用户已经更新了文档，回答还是旧的」这种最难查的问题。

这里用**用户会话**（answer_cache 有 owner 策略）而不是 admin 会话 ——
TS 版用的是 service key，但从纵深防御看，
「就算缓存键算错了也不会跨用户读到」更值得。
"""

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from uuid import UUID

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..log import log_event
from ..models import AnswerCache, Document


def cache_key_of(parts: list[str | int | float]) -> str:
    return hashlib.sha256("|".join(str(p) for p in parts).encode()).hexdigest()


def normalize_question(question: str) -> str:
    return " ".join(question.strip().lower().split())


async def corpus_version(session: AsyncSession, user_id: UUID) -> str:
    """语料版本：把该用户所有「就绪」文档的 id + 更新时间拼起来取哈希。

    任何一次上传或重新处理都会改 updated_at，于是版本变了、缓存失效。
    """
    try:
        rows = (
            await session.execute(
                select(Document.id, Document.updated_at).where(
                    Document.user_id == user_id,
                    Document.status == "ready",
                )
            )
        ).all()
    except Exception as exc:  # noqa: BLE001
        # 读不到就给个随机版本：宁可不用缓存，也不要返回过期答案
        log_event("cache.corpus_version_failed", message=str(exc)[:200])
        return f"unknown-{int(datetime.now(UTC).timestamp())}"

    fingerprint = ";".join(sorted(f"{r.id}:{r.updated_at or ''}" for r in rows))
    return hashlib.sha256(fingerprint.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class CachedAnswer:
    answer: str
    sources: list
    used_count: int


async def read_answer_cache(
    session: AsyncSession,
    key: str,
    ttl_days: int,
) -> CachedAnswer | None:
    try:
        row = (
            await session.execute(select(AnswerCache).where(AnswerCache.key == key))
        ).scalar_one_or_none()
        if row is None:
            return None

        created = row.created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        if datetime.now(UTC) - created > timedelta(days=ttl_days):
            return None

        # 命中计数 + 最近命中时间：以后想按「省了多少次调用」做统计就靠它
        await session.execute(
            update(AnswerCache)
            .where(AnswerCache.key == key)
            .values(hits=(row.hits or 0) + 1, last_hit_at=datetime.now(UTC))
        )
        return CachedAnswer(
            answer=row.answer,
            sources=row.sources or [],
            used_count=row.used_count or 0,
        )
    except Exception as exc:  # noqa: BLE001
        log_event("cache.read_failed", message=str(exc)[:200])
        return None


async def write_answer_cache(
    session: AsyncSession,
    *,
    key: str,
    user_id: UUID,
    question: str,
    answer: str,
    sources: list,
    used_count: int,
    threshold: float,
    model: str,
    corpus_version_value: str,
) -> None:
    try:
        stmt = pg_insert(AnswerCache).values(
            key=key,
            user_id=user_id,
            question=question[:500],
            answer=answer,
            sources=sources,
            used_count=used_count,
            threshold=threshold,
            model=model,
            corpus_version=corpus_version_value,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["key"],
            set_={
                "answer": stmt.excluded.answer,
                "sources": stmt.excluded.sources,
                "used_count": stmt.excluded.used_count,
            },
        )
        await session.execute(stmt)
    except Exception as exc:  # noqa: BLE001
        log_event("cache.write_failed", message=str(exc)[:200])
