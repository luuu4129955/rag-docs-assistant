"""检索调试接口：返回的就是聊天接口真正会用的那批分块（含重排序分数）。

之所以复用 retrieve_chunks 而不是自己写一遍查询，是为了让调试面板
和线上行为完全一致 —— 否则调出来的结果没有参考价值。
"""

from fastapi import APIRouter, HTTPException

from ..config import get_settings
from ..deps import AdminSessionDep, CurrentUser, SessionDep
from ..schemas import SearchRequest
from ..services.rate_limit import enforce
from ..services.rerank import rerank_configured
from ..services.retrieve import retrieve_chunks

router = APIRouter(prefix="/api", tags=["search"])


@router.post("/search")
async def search(
    body: SearchRequest,
    user: CurrentUser,
    session: SessionDep,
    admin: AdminSessionDep,
) -> dict:
    settings = get_settings()
    await enforce(admin, settings, str(user.id), "search")

    query = body.query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query 不能为空")
    k = max(1, min(int(body.k or 5), 20))

    results = await retrieve_chunks(
        session, admin, settings, user.id, query, k, hybrid=body.hybrid
    )

    return {
        "query": query,
        "k": k,
        # 向量阈值：重排序关闭时，拒答靠它
        "threshold": settings.rag_threshold,
        "rerank": rerank_configured(settings),
        # 重排序阈值：未标定时为 0（表示不参与判定，只看排序）
        "rerankThreshold": settings.rerank_threshold or 0,
        "results": [
            {
                "id": c.id,
                "documentId": str(c.document_id),
                "filename": c.filename,
                "idx": c.idx,
                "content": c.content,
                "similarity": float(c.similarity),
                "rerankScore": c.rerank_score,
                "keywordHits": c.keyword_hits,
                "foundBy": c.found_by,
            }
            for c in results
        ],
    }
