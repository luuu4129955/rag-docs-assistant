"""指标与前端错误上报的数据访问。

**注意会话的选用**：`chat_metrics` 和 `client_errors` 只开了 SELECT 策略
（给用户看自己的数据），没有 INSERT 策略 ——
也就是说「写入」必须用 admin 会话（BYPASSRLS），
用用户会话会直接被 RLS 拒掉。这跟 TS 版用 service key 写入是一致的。
"""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..log import log_event
from ..models import ChatMetric, ClientError


async def insert_metric(admin: AsyncSession, **fields: object) -> None:
    """写一条问答指标。失败不能影响问答本身，所以整段吞掉异常只留日志。"""
    try:
        admin.add(ChatMetric(**fields))
        await admin.flush()
    except Exception as exc:  # noqa: BLE001
        log_event("metrics.write_failed", message=str(exc)[:200])


async def list_metrics(session: AsyncSession, user_id: UUID, limit: int = 500) -> list[ChatMetric]:
    rows = await session.execute(
        select(ChatMetric)
        .where(ChatMetric.user_id == user_id)
        .order_by(ChatMetric.created_at.desc())
        .limit(limit)
    )
    return list(rows.scalars().all())


async def insert_client_errors(admin: AsyncSession, rows: list[dict]) -> int:
    if not rows:
        return 0
    admin.add_all([ClientError(**row) for row in rows])
    await admin.flush()
    return len(rows)
