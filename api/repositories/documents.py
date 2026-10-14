"""文档与分块的数据访问。

只写 SQL / 查询，不做业务判断 —— 这样业务逻辑集中在 services 和 routers 里，
换存储方式时只需要改这一层。
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Chunk, Document
from ..services.retrieve import vector_literal


async def list_documents(session: AsyncSession, user_id: UUID) -> list[Document]:
    rows = await session.execute(
        select(Document).where(Document.user_id == user_id).order_by(Document.created_at.desc())
    )
    return list(rows.scalars().all())


async def get_document(session: AsyncSession, doc_id: UUID, user_id: UUID) -> Document | None:
    rows = await session.execute(
        select(Document).where(Document.id == doc_id, Document.user_id == user_id)
    )
    return rows.scalar_one_or_none()


async def insert_document(
    session: AsyncSession,
    *,
    user_id: UUID,
    filename: str,
    storage_path: str,
    size_bytes: int,
) -> Document:
    doc = Document(
        user_id=user_id,
        filename=filename,
        storage_path=storage_path,
        size_bytes=size_bytes,
        status="pending",
    )
    session.add(doc)
    await session.flush()
    return doc


async def chunk_counts(session: AsyncSession, doc_ids: Sequence[UUID]) -> dict[UUID, int]:
    if not doc_ids:
        return {}
    rows = await session.execute(
        select(Chunk.document_id, func.count())
        .where(Chunk.document_id.in_(list(doc_ids)))
        .group_by(Chunk.document_id)
    )
    return {row[0]: int(row[1]) for row in rows.all()}


async def embedded_counts(session: AsyncSession, doc_ids: Sequence[UUID]) -> dict[UUID, int]:
    """只统计「已有向量」的行，不把向量内容拉出来（那要传几十万个浮点数）。"""
    if not doc_ids:
        return {}
    rows = await session.execute(
        select(Chunk.document_id, func.count())
        .where(Chunk.document_id.in_(list(doc_ids)), Chunk.embedding.is_not(None))
        .group_by(Chunk.document_id)
    )
    return {row[0]: int(row[1]) for row in rows.all()}


async def replace_chunks(session: AsyncSession, doc_id: UUID, contents: list[str]) -> None:
    """重跑时先清空旧分块再重写 —— 解析这一步的幂等性就来自这里。"""
    await session.execute(delete(Chunk).where(Chunk.document_id == doc_id))
    if contents:
        session.add_all(
            [
                Chunk(document_id=doc_id, idx=index, content=content, char_count=len(content))
                for index, content in enumerate(contents)
            ]
        )
    await session.flush()


async def pending_chunks(session: AsyncSession, doc_id: UUID, limit: int) -> list[Chunk]:
    rows = await session.execute(
        select(Chunk)
        .where(Chunk.document_id == doc_id, Chunk.embedding.is_(None))
        .order_by(Chunk.id)
        .limit(limit)
    )
    return list(rows.scalars().all())


async def count_pending_chunks(session: AsyncSession, doc_id: UUID) -> int:
    rows = await session.execute(
        select(func.count()).where(Chunk.document_id == doc_id, Chunk.embedding.is_(None))
    )
    return int(rows.scalar_one())


async def set_embeddings(session: AsyncSession, pairs: list[tuple[int, list[float]]]) -> None:
    """批量回写向量。显式 cast 成 vector，因为 asyncpg 不认识这个类型。"""
    if not pairs:
        return
    await session.execute(
        text("update chunks set embedding = cast(:vec as vector(1024)) where id = :id"),
        [{"id": chunk_id, "vec": vector_literal(vector)} for chunk_id, vector in pairs],
    )
