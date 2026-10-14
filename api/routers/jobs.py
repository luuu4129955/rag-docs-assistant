"""后台任务：把「解析 + 分块 + 向量化」拆成一轮一轮的小步执行。

谁能调用：
  1) 定时任务（带 NUXT_JOBS_SECRET）→ 处理所有用户的待办
  2) 已登录用户 → 只处理自己的文档（页面上的「继续处理」按钮走这条路）

一次只做一小批，是为了不撞函数超时；前端负责轮询直到没有待办。
定时任务没有用户身份，走 admin 会话（BYPASSRLS）；用户驱动走 RLS 会话。

> 前提：需要先执行 sql/06（attempts / next_retry_at / dead_lettered_at）
> 和 sql/07（app_current_user + 应用角色），否则模型里的列在库里不存在。
"""

from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings, get_settings
from ..deps import admin_session_scope, session_scope
from ..log import log_event
from ..models import Document
from ..repositories import documents as repo
from ..security import AuthUser
from ..security import current_user as resolve_user
from ..services import storage
from ..services.alerts import alert
from ..services.chunk import chunk_text, sanitize_text
from ..services.embedding import embed_texts
from ..services.ingest import extension_of, extract_text
from ..services.rate_limit import enforce

router = APIRouter(prefix="/api", tags=["jobs"])

PARSE_PER_TICK = 1
EMBED_PER_TICK = 16
EMBED_DOCS_PER_TICK = 5
REQUEUE_PER_TICK = 3

CONTENT_TYPES = {
    "pdf": "application/pdf",
    "md": "text/markdown; charset=utf-8",
    "markdown": "text/markdown; charset=utf-8",
}


@asynccontextmanager
async def _scope(user: AuthUser | None):
    """没有用户身份（定时任务）走 admin 会话，否则走受 RLS 约束的用户会话。"""
    if user is None:
        async with admin_session_scope() as session:
            yield session
    else:
        async with session_scope(user) as session:
            yield session


async def _mark_failure(
    session: AsyncSession,
    settings: Settings,
    doc: Document,
    stage: str,
    error: object,
) -> None:
    """失败处理：没到上限就退避重试，到了上限就进死信并告警。

    退避用指数（30s → 60s → 120s）—— 上游偶发抖动时第二次、第三次往往就过了，
    但连续失败三次基本可以判定不是抖动。
    """
    attempts = (doc.attempts or 0) + 1
    message = str(error)[:300]
    now = datetime.now(UTC)

    if attempts >= (settings.jobs_max_attempts or 3):
        doc.status = "dead"
        doc.attempts = attempts
        doc.error = message
        doc.dead_lettered_at = now
        doc.next_retry_at = None
        doc.updated_at = now
        await session.flush()
        log_event(
            "jobs.dead_letter",
            documentId=str(doc.id),
            filename=doc.filename,
            stage=stage,
            attempts=attempts,
            error=message,
        )
        await alert(
            settings,
            "文档处理进入死信",
            documentId=str(doc.id),
            filename=doc.filename,
            stage=stage,
            attempts=attempts,
            error=message,
        )
        return

    backoff_sec = (settings.jobs_retry_base_sec or 30) * (2 ** (attempts - 1))
    doc.status = "failed"
    doc.attempts = attempts
    doc.error = message
    doc.next_retry_at = now + timedelta(seconds=backoff_sec)
    doc.updated_at = now
    await session.flush()
    log_event(
        "jobs.retry_scheduled",
        documentId=str(doc.id),
        stage=stage,
        attempts=attempts,
        backoffSec=backoff_sec,
    )


async def _requeue_due(settings: Settings, user: AuthUser | None) -> int:
    """把退避到点的失败任务重新排进队列。

    之所以重置回 pending 而不是记个中间态：解析这一步本身是幂等的
    （会先删旧分块再重写），从头跑一遍最省心，也不会留下半截数据。
    """
    now = datetime.now(UTC)
    async with _scope(user) as session:
        stmt = (
            select(Document)
            .where(
                Document.status == "failed",
                Document.dead_lettered_at.is_(None),
                Document.attempts < (settings.jobs_max_attempts or 3),
                (Document.next_retry_at.is_(None)) | (Document.next_retry_at <= now),
            )
            .order_by(Document.created_at)
            .limit(REQUEUE_PER_TICK)
        )
        if user is not None:
            stmt = stmt.where(Document.user_id == user.id)

        requeued = 0
        for doc in (await session.execute(stmt)).scalars().all():
            doc.status = "pending"
            doc.next_retry_at = None
            doc.updated_at = now
            requeued += 1
        await session.flush()
        return requeued


async def _tick_parse(settings: Settings, user: AuthUser | None) -> int:
    async with _scope(user) as session:
        stmt = (
            select(Document.id)
            .where(Document.status == "pending")
            .order_by(Document.created_at)
            .limit(PARSE_PER_TICK)
        )
        if user is not None:
            stmt = stmt.where(Document.user_id == user.id)
        doc_ids = list((await session.execute(stmt)).scalars().all())

    parsed = 0
    for doc_id in doc_ids:
        try:
            # 文件先拉到内存，别在持有事务的同时做网络 IO
            async with _scope(user) as session:
                doc = await session.get(Document, doc_id)
                if doc is None or doc.status != "pending":
                    continue
                storage_path = doc.storage_path

            data = await storage.download(settings, storage_path)
            text = sanitize_text(extract_text(data, extension_of(storage_path)))
            chunks = chunk_text(text)
            if not chunks:
                raise RuntimeError("没有解析出文字内容（扫描版 PDF 需要先做 OCR）")

            async with _scope(user) as session:
                doc = await session.get(Document, doc_id)
                if doc is None:
                    continue
                await repo.replace_chunks(session, doc.id, chunks)
                doc.status = "embedding"
                doc.char_count = len(text)
                doc.error = None
                doc.updated_at = datetime.now(UTC)
            parsed += 1
        except Exception as exc:  # noqa: BLE001
            log_event("jobs.parse_failed", documentId=str(doc_id), message=str(exc)[:200])
            try:
                async with _scope(user) as session:
                    doc = await session.get(Document, doc_id)
                    if doc is not None:
                        await _mark_failure(session, settings, doc, "parse", exc)
            except Exception as inner:  # noqa: BLE001
                log_event("jobs.mark_failure_failed", documentId=str(doc_id), message=str(inner)[:200])
    return parsed


async def _tick_embed(settings: Settings, user: AuthUser | None) -> int:
    async with _scope(user) as session:
        stmt = (
            select(Document.id)
            .where(Document.status == "embedding")
            .order_by(Document.created_at)
            .limit(EMBED_DOCS_PER_TICK)
        )
        if user is not None:
            stmt = stmt.where(Document.user_id == user.id)
        doc_ids = list((await session.execute(stmt)).scalars().all())

    embedded = 0
    for doc_id in doc_ids:
        async with _scope(user) as session:
            rows = await repo.pending_chunks(session, doc_id, EMBED_PER_TICK)
            chunk_ids = [chunk.id for chunk in rows]
            contents = [chunk.content for chunk in rows]

        if not chunk_ids:
            # 没有待向量化的块了 → 这一份就绪
            async with _scope(user) as session:
                doc = await session.get(Document, doc_id)
                if doc is not None:
                    doc.status = "ready"
                    doc.updated_at = datetime.now(UTC)
            continue

        try:
            # 向量缓存表只服务端可见，所以向量化用 admin 会话
            async with admin_session_scope() as admin:
                vectors = await embed_texts(admin, settings, contents)
            async with _scope(user) as session:
                await repo.set_embeddings(session, list(zip(chunk_ids, vectors, strict=True)))
            embedded += len(chunk_ids)
        except Exception as exc:  # noqa: BLE001
            log_event("jobs.embed_failed", documentId=str(doc_id), message=str(exc)[:200])
            try:
                async with _scope(user) as session:
                    doc = await session.get(Document, doc_id)
                    if doc is not None:
                        await _mark_failure(session, settings, doc, "embed", exc)
            except Exception as inner:  # noqa: BLE001
                log_event("jobs.mark_failure_failed", documentId=str(doc_id), message=str(inner)[:200])
            continue

        async with _scope(user) as session:
            if await repo.count_pending_chunks(session, doc_id) == 0:
                doc = await session.get(Document, doc_id)
                if doc is not None:
                    doc.status = "ready"
                    doc.updated_at = datetime.now(UTC)

    return embedded


async def _run_tick(settings: Settings, user: AuthUser | None) -> dict:
    requeued = await _requeue_due(settings, user)
    parsed = await _tick_parse(settings, user)
    embedded = await _tick_embed(settings, user)

    async with _scope(user) as session:
        running_stmt = select(func.count()).where(Document.status.in_(["pending", "embedding"]))
        if user is not None:
            running_stmt = running_stmt.where(Document.user_id == user.id)
        running = int((await session.execute(running_stmt)).scalar_one())

        # 等待重试的失败任务也算「没处理完」——
        # 否则前端会在它们到点重试之前就停止轮询
        retry_stmt = select(func.count()).where(
            Document.status == "failed",
            Document.dead_lettered_at.is_(None),
        )
        if user is not None:
            retry_stmt = retry_stmt.where(Document.user_id == user.id)
        retrying = int((await session.execute(retry_stmt)).scalar_one())

    remaining = running + retrying
    return {
        "parsed": parsed,
        "embedded": embedded,
        "requeued": requeued,
        "retrying": retrying,
        "remaining": remaining,
        "done": remaining == 0,
        "scope": "all" if user is None else "self",
    }


@router.post("/jobs/tick")
async def jobs_tick(request: Request) -> dict:
    settings = get_settings()
    secret = (settings.jobs_secret or "").strip()
    header = request.headers.get("authorization") or ""
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""

    # 定时任务没有用户身份，用密钥换「处理全部用户」的权限
    if secret and token and token == secret:
        return await _run_tick(settings, None)

    user = await resolve_user(header or None)
    # 非定时任务才限流：Cron 带的是密钥，不该被按用户限流误伤
    async with admin_session_scope() as admin:
        await enforce(admin, settings, str(user.id), "jobs")
    return await _run_tick(settings, user)
