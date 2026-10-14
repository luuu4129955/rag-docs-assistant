"""会话与消息的数据访问。"""

from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import Conversation, Message


async def list_conversations(session: AsyncSession, user_id: UUID, limit: int = 50) -> list[dict]:
    """空会话（建了还没提问的）不显示 —— 否则点几次「新对话」就攒一堆。"""
    counts = (
        select(Message.conversation_id, func.count().label("cnt"))
        .group_by(Message.conversation_id)
        .subquery()
    )
    rows = await session.execute(
        select(Conversation.id, Conversation.title, Conversation.created_at)
        .join(counts, counts.c.conversation_id == Conversation.id)
        .where(Conversation.user_id == user_id, counts.c.cnt > 0)
        .order_by(Conversation.created_at.desc())
        .limit(limit)
    )
    return [
        {"id": str(row.id), "title": row.title, "created_at": row.created_at}
        for row in rows.all()
    ]


async def create_conversation(session: AsyncSession, user_id: UUID, title: str = "新对话") -> Conversation:
    conversation = Conversation(user_id=user_id, title=title)
    session.add(conversation)
    await session.flush()
    return conversation


async def get_conversation(
    session: AsyncSession,
    conversation_id: UUID,
    user_id: UUID,
) -> Conversation | None:
    rows = await session.execute(
        select(Conversation).where(
            Conversation.id == conversation_id,
            Conversation.user_id == user_id,
        )
    )
    return rows.scalar_one_or_none()


async def update_title(session: AsyncSession, conversation_id: UUID, title: str) -> None:
    conversation = (
        await session.execute(select(Conversation).where(Conversation.id == conversation_id))
    ).scalar_one_or_none()
    if conversation is not None:
        conversation.title = title
        await session.flush()


async def list_messages(session: AsyncSession, conversation_id: UUID) -> list[Message]:
    rows = await session.execute(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.id)
    )
    return list(rows.scalars().all())


async def insert_message(
    session: AsyncSession,
    *,
    conversation_id: UUID,
    role: str,
    content: str,
    sources: dict | None,
) -> Message:
    message = Message(
        conversation_id=conversation_id,
        role=role,
        content=content,
        sources=sources,
    )
    session.add(message)
    await session.flush()
    return message
