"""分片上传会话的数据访问。

`upload_sessions` 有 owner 策略，所以用用户会话即可。
"""

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import UploadSession


async def find_open_session(
    session: AsyncSession,
    user_id: UUID,
    fingerprint: str,
) -> UploadSession | None:
    """认领没传完的上传：同一用户 + 同一指纹 + 还开着。"""
    rows = await session.execute(
        select(UploadSession)
        .where(
            UploadSession.user_id == user_id,
            UploadSession.fingerprint == fingerprint,
            UploadSession.status == "open",
        )
        .order_by(UploadSession.created_at.desc())
        .limit(1)
    )
    return rows.scalar_one_or_none()


async def create_session(
    session: AsyncSession,
    *,
    user_id: UUID,
    filename: str,
    size_bytes: int,
    fingerprint: str,
    chunk_size: int,
    total_parts: int,
) -> UploadSession:
    record = UploadSession(
        user_id=user_id,
        filename=filename,
        size_bytes=size_bytes,
        fingerprint=fingerprint,
        chunk_size=chunk_size,
        total_parts=total_parts,
        status="open",
    )
    session.add(record)
    await session.flush()
    return record


async def get_session(session: AsyncSession, upload_id: UUID, user_id: UUID) -> UploadSession | None:
    rows = await session.execute(
        select(UploadSession).where(
            UploadSession.id == upload_id,
            UploadSession.user_id == user_id,
        )
    )
    return rows.scalar_one_or_none()


async def touch(session: AsyncSession, upload_id: UUID) -> None:
    record = (
        await session.execute(select(UploadSession).where(UploadSession.id == upload_id))
    ).scalar_one_or_none()
    if record is not None:
        record.updated_at = datetime.now(UTC)
        await session.flush()


async def mark_done(session: AsyncSession, upload_id: UUID) -> None:
    record = (
        await session.execute(select(UploadSession).where(UploadSession.id == upload_id))
    ).scalar_one_or_none()
    if record is not None:
        record.status = "done"
        record.updated_at = datetime.now(UTC)
        await session.flush()
