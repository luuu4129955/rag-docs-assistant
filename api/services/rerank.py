"""重排序：向量只判断「语义像不像」，reranker 判断「这段材料能不能回答问题」。

注意：BAAI/bge-reranker-v2-m3 返回的是**未归一化的原始分**，
数值范围和模型绑定，没有「0.5 以上算相关」这种通用阈值 ——
必须用自己的数据看分布（用例：`model/eval/calibrate-rerank.mjs`）。
"""

from dataclasses import dataclass

from ..config import Settings
from ..http import shared_client


@dataclass(frozen=True)
class RerankItem:
    index: int
    score: float


def rerank_configured(settings: Settings) -> bool:
    return bool(settings.embedding_key.strip())


async def rerank_texts(
    settings: Settings,
    query: str,
    documents: list[str],
    top_n: int,
) -> list[RerankItem]:
    key = settings.embedding_key.strip()
    if not key or not documents:
        return []

    model = settings.rerank_model or "BAAI/bge-reranker-v2-m3"
    payload = {
        "model": model,
        "query": query,
        "documents": documents,
        "top_n": min(top_n, len(documents)),
        "return_documents": False,
    }

    res = await shared_client().post(
        f"{settings.rerank_base_resolved}/rerank",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        json=payload,
    )
    if res.status_code >= 400:
        raise RuntimeError(f"rerank {res.status_code}: {res.text[:200]}")

    results = res.json().get("results") or []
    return [
        RerankItem(index=int(item["index"]), score=float(item["relevance_score"]))
        for item in results
    ]
