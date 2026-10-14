"""对话路由：检索 → 拼上下文 → 流式生成，带引用、拒答、缓存与指标。

和 TS 版保持一致的四件事：
  1. 答案缓存放在**检索之前** —— 命中时整条链路（向量化→检索→重排→模型）全部跳过，
     这才是缓存的意义；放在检索之后只能省下模型调用那一段，收益小得多。
  2. 有材料但一块都没过阈值 → 直接拒答，不花模型的钱。
  3. 拒答也包装成 SSE，前端不用为它写特例。
  4. 流式过程中「顺路」统计首字延迟、token 用量、答案全文。

**和 TS 版不同的一点**：DB 操作在开始流式输出**之前**做完、连接释放，
再返回 StreamingResponse —— 一个 SSE 请求可能持续几十秒，
一直握着事务会把连接池很快耗光。
"""

import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..config import Settings, get_settings
from ..deps import CurrentUser, admin_session_scope, session_scope
from ..http import shared_client
from ..log import log_event
from ..repositories import metrics as metrics_repo
from ..schemas import MAX_CHARS, MAX_TURNS, ChatRequest
from ..security import AuthUser
from ..services.answer_cache import (
    cache_key_of,
    corpus_version,
    normalize_question,
    read_answer_cache,
    write_answer_cache,
)
from ..services.context import build_context, build_system_prompt
from ..services.rate_limit import enforce
from ..services.retrieve import retrieve_chunks, select_used, source_payload

router = APIRouter(prefix="/api", tags=["chat"])

REFUSAL_TEXT = (
    "文档里没有找到和这个问题相关的内容，我无法依据材料回答。"
    "可以换个说法，或者先上传相关文档。"
)


def sse(payload: dict) -> bytes:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode()


async def _synth_stream(prefix: bytes, text: str) -> AsyncIterator[bytes]:
    """把一段固定文本包装成和模型一样的 SSE 流。

    好处是前端不用为「拒答」和「缓存命中」写特例 —— 收到的还是 delta。
    """
    yield prefix
    yield sse({"choices": [{"delta": {"content": text}}]})
    yield b"data: [DONE]\n\n"


@dataclass
class _StreamContext:
    """流式阶段需要的一切 —— 会话已经关了，这里只留下纯数据。"""

    user: AuthUser
    settings: Settings
    started_at: float
    conversation_id: str | None
    model: str
    threshold: float
    cache_key: str
    source_event: bytes
    question: str = ""
    corpus_version: str = ""
    sources: list[dict] = field(default_factory=list)
    used_count: int = 0
    candidates_count: int = 0
    retrieval_ms: int = 0


async def _finish(
    ctx: _StreamContext,
    answer: str,
    first_token_ms: int | None,
    usage: dict[str, int | None],
    error: str | None,
) -> None:
    """流式结束后收尾：写答案缓存、写指标。

    这里重新开两个短事务 —— 而不是把请求开始时的长事务一直握着。
    指标写入失败不影响用户已经拿到的答案，所以单独 try 包住。
    """
    total_ms = int((time.perf_counter() - ctx.started_at) * 1000)

    # 只有正常答完、且材料确实用上了才缓存；出错和拒答都不缓存
    if not error and answer and ctx.cache_key:
        try:
            async with session_scope(ctx.user) as session:
                await write_answer_cache(
                    session,
                    key=ctx.cache_key,
                    user_id=ctx.user.id,
                    question=ctx.question,
                    answer=answer,
                    sources=ctx.sources,
                    used_count=ctx.used_count,
                    threshold=ctx.threshold,
                    model=ctx.model,
                    corpus_version_value=ctx.corpus_version,
                )
        except Exception as exc:  # noqa: BLE001
            log_event("cache.write_failed", message=str(exc)[:200])

    log_event(
        "chat.done",
        userId=str(ctx.user.id),
        totalMs=total_ms,
        firstTokenMs=first_token_ms,
        answerChars=len(answer),
        retrieved=ctx.candidates_count,
        used=ctx.used_count,
        promptTokens=usage.get("prompt"),
        completionTokens=usage.get("completion"),
        error=error,
    )

    try:
        async with admin_session_scope() as admin:
            await metrics_repo.insert_metric(
                admin,
                user_id=ctx.user.id,
                conversation_id=_as_uuid(ctx.conversation_id),
                model=ctx.model,
                retrieval_ms=ctx.retrieval_ms,
                first_token_ms=first_token_ms,
                total_ms=total_ms,
                prompt_tokens=usage.get("prompt"),
                completion_tokens=usage.get("completion"),
                retrieved_count=ctx.candidates_count,
                used_count=ctx.used_count,
                error=error,
            )
    except Exception as exc:  # noqa: BLE001
        log_event("metrics.write_failed", message=str(exc)[:200])


def _as_uuid(value: str | None):
    from uuid import UUID

    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None


async def _stream_model(ctx: _StreamContext, messages: list[dict]) -> AsyncIterator[bytes]:
    """调上游模型并原样转发 SSE，同时顺路统计首字延迟与 token 用量。

    转发而不是「解析完再重组」的好处：前端拿到的和直连模型完全一致，
    上游加了新字段也不会丢。
    """
    settings = ctx.settings
    payload = {
        "model": ctx.model,
        "messages": messages,
        "stream": True,
        "temperature": 0.3,
        # 让上游在最后一块里带上 token 用量，指标才有的算
        "stream_options": {"include_usage": True},
    }

    answer_parts: list[str] = []
    first_token_ms: int | None = None
    usage: dict[str, int | None] = {}
    buffer = ""
    error: str | None = None

    # 先把召回结果推给前端：引用列表要显示，且必须在正文之前到达
    yield ctx.source_event

    def absorb(text: str) -> None:
        """从上游 SSE 里挑出 delta 和 usage。"""
        nonlocal buffer, first_token_ms, usage
        buffer += text
        parts = buffer.split("\n\n")
        buffer = parts.pop()
        for part in parts:
            line = next((ln for ln in part.split("\n") if ln.startswith("data: ")), None)
            if line is None:
                continue
            data = line[6:].strip()
            if data == "[DONE]":
                continue
            try:
                obj = json.loads(data)
            except json.JSONDecodeError:
                continue
            choices = obj.get("choices") or [{}]
            delta = (choices[0].get("delta") or {}).get("content")
            if delta:
                if first_token_ms is None:
                    first_token_ms = int((time.perf_counter() - ctx.started_at) * 1000)
                answer_parts.append(delta)
            if obj.get("usage"):
                usage = {
                    "prompt": obj["usage"].get("prompt_tokens"),
                    "completion": obj["usage"].get("completion_tokens"),
                }

    # read timeout 是「距离上一次收到数据」的间隔：只要模型一直在吐字就不会触发，
    # 只有真的卡住才触发。上一轮评测里出现过一次 132 秒的空响应，
    # 原来的 120 秒超时太长、而且异常消息是空的，看不出发生了什么。
    timeout = httpx.Timeout(30.0, connect=15.0)
    url = f"{settings.chat_base.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {settings.chat_key_resolved}",
    }

    try:
        for attempt in range(2):
            try:
                client = shared_client()
                async with client.stream(
                    "POST", url, headers=headers, json=payload, timeout=timeout
                ) as res:
                    if res.status_code >= 400:
                        detail = (await res.aread())[:300].decode(errors="replace")
                        log_event("chat.upstream_error", status=res.status_code, detail=detail)
                        error = f"上游 {res.status_code}"
                        yield sse({"error": f"模型接口调用失败：{detail}"})
                        break

                    async for chunk in res.aiter_bytes():
                        yield chunk
                        absorb(chunk.decode("utf-8", errors="replace"))
                error = None
                break
            except Exception as exc:  # noqa: BLE001
                kind = type(exc).__name__
                error = f"{kind}: {exc}"[:200]
                # 一定要记 errorType：有些异常（超时、取消）的 str() 是空串，
                # 只记 message 会得到一条什么信息都没有的日志。
                log_event(
                    "chat.stream_failed",
                    attempt=attempt + 1,
                    errorType=kind,
                    message=str(exc)[:200],
                    receivedChars=sum(map(len, answer_parts)),
                )
                # 已经吐给前端内容了就不再重试 —— 重试会让人收到两份半截回答
                if answer_parts or attempt == 1:
                    yield sse({"error": "生成中断"})
                    break
                log_event("chat.retry_upstream", reason=kind)
                buffer = ""
    finally:
        # 用户中途关掉页面时，生成器被关闭 → 上面的 with 会退回 → 上游连接断开，
        # 不会继续烧 token
        await _finish(ctx, "".join(answer_parts), first_token_ms, usage, error)


@router.post("/chat")
async def chat(body: ChatRequest, user: CurrentUser) -> StreamingResponse:
    """问答主链路。

    注意这里**没有**用 SessionDep：yield 型依赖会一直活到流式响应结束，
    那样整个 SSE 期间都握着一个事务。改成自己开、自己关，
    把「检索/缓存」和「流式输出」在连接层面彻底分开。
    """
    settings = get_settings()
    started_at = time.perf_counter()
    log_event("chat.start", userId=str(user.id))

    # 限流放在最前面：有人刷接口时，连检索和模型调用都不该发生
    async with admin_session_scope() as admin:
        await enforce(admin, settings, str(user.id), "chat")

    if not settings.chat_key_resolved:
        raise HTTPException(
            status_code=500,
            detail="服务端未配置 NUXT_CHAT_KEY（或 NUXT_DEEPSEEK_KEY）",
        )

    # 前端传来的内容一律不可信：过滤掉非法角色，限制条数和单条长度
    messages = [
        {"role": m.role, "content": m.content[:MAX_CHARS]} for m in body.messages if m.content
    ][-MAX_TURNS:]
    if not messages:
        raise HTTPException(status_code=400, detail="messages 不能为空")

    model = settings.chat_model or "deepseek-chat"
    threshold = settings.rag_threshold or 0.35
    top_k = settings.rag_top_k or 6
    rerank_threshold = settings.rerank_threshold or 0
    last_user = next((m for m in reversed(messages) if m["role"] == "user"), None)

    cache_key = ""
    version = ""
    stream_ctx: _StreamContext | None = None
    messages_for_model: list[dict] = messages
    synth: tuple[bytes, str] | None = None

    async with session_scope(user) as session, admin_session_scope() as admin:
        # ---------- 答案缓存：放在检索之前 ----------
        if settings.answer_cache and last_user:
            version = await corpus_version(session, user.id)
            cache_key = cache_key_of(
                [
                    str(user.id),
                    model,
                    threshold,
                    rerank_threshold,
                    top_k,
                    version,
                    normalize_question(last_user["content"]),
                ]
            )
            cached = await read_answer_cache(session, cache_key, settings.cache_ttl_days or 7)
            if cached is not None:
                log_event("chat.cache_hit", userId=str(user.id), answerChars=len(cached.answer))
                await metrics_repo.insert_metric(
                    admin,
                    user_id=user.id,
                    conversation_id=_as_uuid(body.conversation_id),
                    model=model,
                    total_ms=int((time.perf_counter() - started_at) * 1000),
                    retrieved_count=len(cached.sources),
                    used_count=cached.used_count,
                    cached=True,
                )
                cached_event = sse(
                    {
                        "sources": cached.sources,
                        "usedCount": cached.used_count,
                        "retrieved": True,
                        "threshold": threshold,
                        "model": model,
                        "cached": True,
                    }
                )
                synth = (cached_event, cached.answer)

        if synth is None:
            # ---------- 检索 ----------
            candidates = []
            used = []
            retrieval_ok = False
            retrieval_started = time.perf_counter()
            if last_user and settings.embedding_key:
                try:
                    candidates = await retrieve_chunks(
                        session, admin, settings, user.id, last_user["content"], top_k
                    )
                    retrieval_ok = True
                    used = select_used(candidates, settings, threshold)
                except Exception as exc:  # noqa: BLE001 —— 检索失败不拖垮聊天
                    log_event("chat.retrieval_failed", userId=str(user.id), message=str(exc)[:200])
            retrieval_ms = int((time.perf_counter() - retrieval_started) * 1000)

            sources = source_payload(candidates)
            source_event = sse(
                {
                    "sources": sources,
                    "usedCount": len(used),
                    "retrieved": retrieval_ok,
                    "threshold": threshold,
                    "model": model,
                }
            )

            # 有材料但一块都没过阈值 → 直接拒答，不花模型的钱
            if retrieval_ok and not used:
                log_event(
                    "chat.refused",
                    userId=str(user.id),
                    retrievalMs=retrieval_ms,
                    retrieved=len(candidates),
                    topSimilarity=candidates[0].similarity if candidates else None,
                )
                await metrics_repo.insert_metric(
                    admin,
                    user_id=user.id,
                    conversation_id=_as_uuid(body.conversation_id),
                    model=model,
                    retrieval_ms=retrieval_ms,
                    total_ms=int((time.perf_counter() - started_at) * 1000),
                    retrieved_count=len(candidates),
                    used_count=0,
                    refused=True,
                )
                synth = (source_event, REFUSAL_TEXT)
            else:
                # 小检索、大上下文：把命中块的前后邻居一起带上，并按预算裁剪
                blocks = await build_context(session, used) if used else []
                if blocks:
                    messages_for_model = [
                        {"role": "system", "content": build_system_prompt(blocks)},
                        *messages,
                    ]
                stream_ctx = _StreamContext(
                    user=user,
                    settings=settings,
                    started_at=started_at,
                    conversation_id=body.conversation_id,
                    model=model,
                    threshold=threshold,
                    cache_key=cache_key,
                    source_event=source_event,
                    question=last_user["content"] if last_user else "",
                    corpus_version=version,
                    sources=sources,
                    used_count=len(used),
                    candidates_count=len(candidates),
                    retrieval_ms=retrieval_ms,
                )

    # 会话到这里已经关闭 —— 下面才开始吐 SSE
    headers = {"Cache-Control": "no-cache"}
    if synth is not None:
        return StreamingResponse(_synth_stream(*synth), media_type="text/event-stream", headers=headers)

    return StreamingResponse(
        _stream_model(stream_ctx, messages_for_model),  # type: ignore[arg-type]
        media_type="text/event-stream",
        headers=headers,
    )
