"""检索：向量 + 关键词两路，RRF 融合，再交给 reranker 精排。

移植自 server/utils/retrieve.ts，行为保持一致。
两段式：向量粗召回 Top-N（默认 20）→ reranker 精排 → 取前 k 块。
重排序失败不致命，降级成「只用向量结果」并在日志里留痕。
"""

from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..log import log_event
from .embedding import embed_texts
from .rerank import rerank_configured, rerank_texts

# RRF 的平滑常数：经验值 60，让「第一名和第 100 名」的差距不要过于悬殊
RRF_K = 60


@dataclass
class RetrievedChunk:
    id: int
    document_id: UUID
    filename: str
    idx: int
    content: str
    similarity: float
    keyword_hits: int | None = None
    found_by: list[str] = field(default_factory=list)
    fusion_score: float | None = None
    rerank_score: float | None = None


def vector_literal(vector: list[float]) -> str:
    """pgvector 认识的字面量形式：'[0.1,0.2,...]'。"""
    return "[" + ",".join(repr(float(x)) for x in vector) + "]"


def fuse_by_rrf(lists: list[tuple[str, list[RetrievedChunk]]], limit: int) -> list[RetrievedChunk]:
    """RRF 融合：不看分数、只看名次。

    好处是不需要把「余弦相似度」和「关键词命中数」这两种量纲不同的分数
    强行归一化 —— 那是混合检索里最容易做错的一步。
    """
    acc: dict[str, dict] = {}

    for tag, items in lists:
        for index, item in enumerate(items):
            key = f"{item.document_id}#{item.idx}"
            entry = acc.get(key)
            if entry is None:
                entry = {"item": item, "score": 0.0, "tags": set()}
                acc[key] = entry
            entry["score"] += 1 / (RRF_K + index + 1)
            entry["tags"].add(tag)
            if item.similarity:
                entry["item"].similarity = item.similarity
            if item.keyword_hits:
                entry["item"].keyword_hits = item.keyword_hits

    ordered = sorted(acc.values(), key=lambda e: e["score"], reverse=True)[:limit]
    return [
        RetrievedChunk(
            id=e["item"].id,
            document_id=e["item"].document_id,
            filename=e["item"].filename,
            idx=e["item"].idx,
            content=e["item"].content,
            similarity=e["item"].similarity,
            keyword_hits=e["item"].keyword_hits,
            found_by=sorted(e["tags"]),
            fusion_score=e["score"],
        )
        for e in ordered
    ]


async def keyword_search(
    session: AsyncSession,
    owner: UUID,
    query: str,
    limit: int,
) -> list[RetrievedChunk]:
    """关键词那一路：交给数据库函数 search_chunks_keyword，按命中词数排序。"""
    rows = (
        await session.execute(
            text(
                "select * from search_chunks_keyword("
                "p_query => :q, p_limit => :lim, p_owner => cast(:owner as uuid))"
            ),
            {"q": query, "lim": limit, "owner": str(owner)},
        )
    ).all()

    return [
        RetrievedChunk(
            id=int(r.id),
            document_id=r.document_id,
            filename=r.filename,
            idx=int(r.idx),
            content=r.content,
            # 关键词那一路没有余弦相似度，置 0；排序交给 RRF 和 reranker
            similarity=0.0,
            keyword_hits=int(r.hits),
            found_by=["keyword"],
        )
        for r in rows
    ]


async def retrieve_chunks(
    session: AsyncSession,
    admin: AsyncSession,
    settings: Settings,
    owner: UUID,
    query: str,
    k: int,
    hybrid: bool | None = None,
) -> list[RetrievedChunk]:
    # 问题和分块必须用同一个模型向量化，否则两个向量不在同一个空间里
    vectors = await embed_texts(admin, settings, [query])
    query_vector = vectors[0]

    recall_size = max(k, settings.rerank_top_n or 20)
    rows = (
        await session.execute(
            text(
                "select * from match_chunks("
                "query_embedding => cast(:vec as vector(1024)), "
                "match_count => :count, owner => cast(:owner as uuid))"
            ),
            {"vec": vector_literal(query_vector), "count": recall_size, "owner": str(owner)},
        )
    ).all()

    candidates = [
        RetrievedChunk(
            id=int(r.id),
            document_id=r.document_id,
            filename=r.filename,
            idx=int(r.idx),
            content=r.content,
            similarity=float(r.similarity),
            found_by=["vector"],
        )
        for r in rows
    ]

    # 关键词那一路：函数还没建（迁移没跑）时自动跳过，不影响主流程
    hybrid_on = settings.hybrid_enabled if hybrid is None else hybrid
    if hybrid_on:
        try:
            keyword_hits = await keyword_search(session, owner, query, recall_size)
            if keyword_hits:
                candidates = fuse_by_rrf(
                    [("vector", candidates), ("keyword", keyword_hits)],
                    recall_size,
                )
        except Exception as exc:  # noqa: BLE001
            log_event("retrieve.keyword_failed", message=str(exc)[:200])

    if len(candidates) <= 1 or not rerank_configured(settings):
        return candidates[:k]

    try:
        ranked = await rerank_texts(settings, query, [c.content for c in candidates], len(candidates))
        if not ranked:
            return candidates[:k]
        score_of = {item.index: item.score for item in ranked}
        for index, candidate in enumerate(candidates):
            candidate.rerank_score = score_of.get(index)
        candidates.sort(
            key=lambda c: c.rerank_score if c.rerank_score is not None else float("-inf"),
            reverse=True,
        )
        return candidates[:k]
    except Exception as exc:  # noqa: BLE001
        log_event("retrieve.rerank_failed", message=str(exc)[:200])
        return candidates[:k]


def source_payload(candidates: list[RetrievedChunk]) -> list[dict]:
    """给前端的来源列表：块的编号和前端列表里的编号一一对应。"""
    return [
        {
            "n": i + 1,
            "documentId": str(c.document_id),
            "filename": c.filename,
            "idx": c.idx,
            "similarity": float(c.similarity),
            "rerankScore": c.rerank_score,
            "keywordHits": c.keyword_hits,
            "foundBy": c.found_by,
            "content": c.content,
        }
        for i, c in enumerate(candidates)
    ]


def select_used(
    candidates: list[RetrievedChunk],
    settings: Settings,
    threshold: float,
) -> list[RetrievedChunk]:
    """决定哪些块进 prompt。

    有重排序分数时按它筛（向量只能看「像不像」，reranker 判断「能不能回答」）；
    没标定阈值就退回向量相似度。
    """
    rerank_threshold = settings.rerank_threshold or 0
    if rerank_configured(settings) and rerank_threshold > 0:
        return [
            c for c in candidates
            if c.rerank_score is not None and c.rerank_score >= rerank_threshold
        ]
    return [c for c in candidates if c.similarity >= threshold]
