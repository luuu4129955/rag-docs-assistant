"""令牌桶限流。

和 TS 版是同一个设计：桶放在数据库里（Serverless/多实例共享），
取令牌的动作封装成数据库函数 `take_token`，
「读-改-写」在一次加锁操作里完成，并发请求不会各读到旧值再各扣一次。

容错：拿不到数据库（迁移没跑）时一律放行 ——
限流是保护措施，不该反过来把功能整个卡死。
`rate_limits` 表开了 RLS 但没有策略，所以这里必须用 **admin 会话**。
"""

from dataclasses import dataclass
from typing import Literal

from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import Settings
from ..log import log_event

RateAction = Literal[
    "chat",
    "search",
    "uploadInit",
    "uploadPart",
    "uploadComplete",
    "write",
    "telemetry",
    "jobs",
]

# 各动作的默认额度（每分钟, 突发）。越贵、越容易被刷的动作桶越小；
# 分片上传要放大 —— 40MB 的文件按 1MB 切片就是 40 个请求。
PRESETS: dict[str, tuple[int, int]] = {
    "chat": (30, 20),
    "search": (60, 30),
    "uploadInit": (12, 6),
    "uploadPart": (600, 120),
    "uploadComplete": (12, 6),
    "write": (60, 20),
    "telemetry": (120, 40),
    "jobs": (600, 240),
}


@dataclass(frozen=True)
class RateDecision:
    allowed: bool
    remaining: float
    retry_after_ms: int


async def take_token(
    admin: AsyncSession,
    key: str,
    capacity: float,
    refill_per_sec: float,
    cost: float = 1.0,
) -> RateDecision:
    try:
        row = (
            await admin.execute(
                text(
                    "select * from take_token("
                    "p_key => :k, p_capacity => :cap, "
                    "p_refill_per_sec => :refill, p_cost => :cost)"
                ),
                {"k": key, "cap": capacity, "refill": refill_per_sec, "cost": cost},
            )
        ).one()
        return RateDecision(
            allowed=bool(row.allowed),
            remaining=float(row.remaining),
            retry_after_ms=int(row.retry_after_ms),
        )
    except Exception as exc:  # noqa: BLE001
        log_event("rate_limit.unavailable", key=key, message=str(exc)[:200])
        return RateDecision(allowed=True, remaining=capacity, retry_after_ms=0)


async def enforce(
    admin: AsyncSession,
    settings: Settings,
    subject: str,
    action: RateAction,
) -> None:
    """在接口里就地限流：超限直接抛 429。

    之所以让它抛异常而不是返回布尔值，是为了不给调用方「忘了判断」的机会。
    """
    if not settings.rate_limit_enabled:
        return

    per_min, burst = PRESETS.get(action, (60, 20))
    if action == "chat":
        per_min = settings.rate_limit_chat_per_min or per_min
        burst = settings.rate_limit_chat_burst or burst

    decision = await take_token(admin, f"{action}:{subject}", burst, per_min / 60)
    if decision.allowed:
        return

    wait_sec = max(1, -(-decision.retry_after_ms // 1000))
    log_event(
        "rate_limit.blocked",
        subject=subject,
        action=action,
        retryAfterMs=decision.retry_after_ms,
    )
    raise HTTPException(
        status_code=429,
        detail=f"操作太频繁，请 {wait_sec} 秒后再试",
        headers={"Retry-After": str(wait_sec)},
    )
