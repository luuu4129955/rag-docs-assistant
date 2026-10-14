"""线上指标汇总：给页面上的「评测」面板用。

只取最近 500 条、在应用层算分位数 —— 样本量小的时候够用；
数据涨上去应该换成数据库聚合或专门的指标系统（这也是 README 里记的取舍）。
"""

from fastapi import APIRouter

from ..config import get_settings
from ..deps import CurrentUser, SessionDep
from ..repositories import metrics as repo

router = APIRouter(prefix="/api", tags=["metrics"])


def _numbers(values: list[int | None]) -> list[int]:
    return sorted(v for v in values if isinstance(v, (int, float)))


def _quantile(values: list[int], q: float) -> int | None:
    if not values:
        return None
    pos = (len(values) - 1) * q
    low = int(pos)
    high = min(low + 1, len(values) - 1)
    return round(values[low] + (values[high] - values[low]) * (pos - low))


def _mean(values: list[int]) -> int | None:
    return round(sum(values) / len(values)) if values else None


@router.get("/metrics/summary")
async def summary(user: CurrentUser, session: SessionDep) -> dict:
    rows = await repo.list_metrics(session, user.id, limit=500)
    settings = get_settings()

    total = _numbers([r.total_ms for r in rows])
    first_token = _numbers([r.first_token_ms for r in rows])
    retrieval = _numbers([r.retrieval_ms for r in rows])

    refused_count = sum(1 for r in rows if r.refused)
    cached_count = sum(1 for r in rows if r.cached)

    # 命中缓存的那一轮没有真实模型调用，不能算进 token 与成本
    billed = [r for r in rows if not r.cached]
    prompt_tokens = sum(r.prompt_tokens or 0 for r in billed)
    completion_tokens = sum(r.completion_tokens or 0 for r in billed)

    price_in = settings.price_in_per_m or 0
    price_out = settings.price_out_per_m or 0
    estimated = round(
        (prompt_tokens / 1_000_000) * price_in + (completion_tokens / 1_000_000) * price_out,
        4,
    )

    return {
        "sampleSize": len(rows),
        "since": rows[-1].created_at if rows else None,
        "until": rows[0].created_at if rows else None,
        "refusalRate": round(refused_count / len(rows), 3) if rows else None,
        "latency": {
            "avgMs": _mean(total),
            "p50Ms": _quantile(total, 0.5),
            "p95Ms": _quantile(total, 0.95),
            "firstTokenAvgMs": _mean(first_token),
            "retrievalAvgMs": _mean(retrieval),
        },
        "cache": {
            "hits": cached_count,
            "hitRate": round(cached_count / len(rows), 3) if rows else None,
        },
        "tokens": {
            "prompt": prompt_tokens,
            "completion": completion_tokens,
            "avgPromptPerAsk": round(prompt_tokens / len(billed)) if billed else None,
            # 按配置单价估算（默认 0 表示用的免费模型）
            "estimatedCost": estimated,
            "currency": "CNY",
        },
    }
