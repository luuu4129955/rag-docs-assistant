"""会话与消息路由。

引用信息要跟着消息一起存：只存正文的话，刷新后 [1] 还在、点开却没内容。
这里顺手做两件事：限制条数与单条长度（防止有人往 jsonb 里灌垃圾），
以及在没有 sources 列的库上优雅降级（老库没跑迁移也不至于存不了消息）。
"""

from uuid import UUID

from fastapi import APIRouter, HTTPException

from ..deps import CurrentUser, SessionDep
from ..log import log_event
from ..repositories import conversations as repo
from ..schemas import ConversationPatch, MessageCreate

router = APIRouter(prefix="/api", tags=["conversations"])

MAX_CITATION_SOURCES = 20
MAX_CITATION_CHARS = 2000


@router.get("/conversations")
async def list_conversations(user: CurrentUser, session: SessionDep) -> list[dict]:
    return await repo.list_conversations(session, user.id)


@router.post("/conversations")
async def create_conversation(user: CurrentUser, session: SessionDep) -> dict:
    conversation = await repo.create_conversation(session, user.id)
    await session.flush()
    return {
        "id": str(conversation.id),
        "title": conversation.title,
        "created_at": conversation.created_at,
    }


@router.get("/conversations/{conversation_id}")
async def get_conversation(conversation_id: UUID, user: CurrentUser, session: SessionDep) -> list[dict]:
    # 先确认这个会话是本人的，再读消息；否则拿着别人的 id 就能读历史
    conversation = await repo.get_conversation(session, conversation_id, user.id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    messages = await repo.list_messages(session, conversation_id)
    return [
        {
            "id": m.id,
            "role": m.role,
            "content": m.content,
            "sources": m.sources,
        }
        for m in messages
    ]


@router.patch("/conversations/{conversation_id}")
async def patch_conversation(
    conversation_id: UUID,
    body: ConversationPatch,
    user: CurrentUser,
    session: SessionDep,
) -> dict:
    title = body.title.strip()[:60]
    if not title:
        raise HTTPException(status_code=400, detail="title 不能为空")

    conversation = await repo.get_conversation(session, conversation_id, user.id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    await repo.update_title(session, conversation_id, title)
    return {"id": str(conversation_id), "title": title}


def _normalize_citations(citations: object) -> dict | None:
    """把前端传来的引用裁到合理范围再入库。"""
    sources = getattr(citations, "sources", None)
    if not sources:
        return None
    return {
        "sources": [
            {
                "n": s.n or index + 1,
                "filename": s.filename[:200],
                "idx": s.idx,
                "similarity": s.similarity,
                "content": s.content[:MAX_CITATION_CHARS],
            }
            for index, s in enumerate(sources[:MAX_CITATION_SOURCES])
        ],
        "usedCount": getattr(citations, "used_count", 0),
        "threshold": getattr(citations, "threshold", 0.0),
    }


@router.post("/messages")
async def post_message(body: MessageCreate, user: CurrentUser, session: SessionDep) -> dict:
    try:
        conversation_id = UUID(body.conversation_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="conversationId 不合法") from None
    if not body.content.strip():
        raise HTTPException(status_code=400, detail="content 不能为空")

    # RLS 已经会挡住写别人的会话，这里再显式查一次 —— 两层保护
    conversation = await repo.get_conversation(session, conversation_id, user.id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="会话不存在")

    try:
        message = await repo.insert_message(
            session,
            conversation_id=conversation_id,
            role=body.role,
            content=body.content,
            sources=_normalize_citations(body.citations),
        )
    except Exception as exc:  # noqa: BLE001
        log_event("messages.insert_failed", message=str(exc)[:200])
        raise HTTPException(status_code=500, detail="保存消息失败") from None

    return {"id": message.id, "role": message.role, "content": message.content}
