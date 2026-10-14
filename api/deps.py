"""FastAPI 依赖注入：当前用户、数据库会话。

这一层的存在意义是**不给漏掉 RLS 上下文的机会**：
每个面向用户的请求都通过 `get_session` 拿会话，而它一定会先
`set_config('app.user_id', ..., true)` 把身份放进当前事务。
业务代码拿到的 session 天然就是「已限定为本人的视图」。

两个必须记住的约束（见 MIGRATION-PYTHON.md 3.3）：
  1. 一个请求一个事务 —— set_config(..., true) 只在当前事务内有效，
     中间 commit 会让身份失效；
  2. 流式响应不要握着事务 —— DB 操作做完、会话关闭，再开始吐 SSE。
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, Header, HTTPException
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from . import db
from .security import AuthUser
from .security import current_user as _current_user


async def current_user(authorization: Annotated[str | None, Header()] = None) -> AuthUser:
    return await _current_user(authorization)


CurrentUser = Annotated[AuthUser, Depends(current_user)]


def _factory(role: str) -> async_sessionmaker[AsyncSession]:
    factory = db.session_factory(role)
    if factory is None:
        raise HTTPException(
            status_code=500,
            detail="服务端未配置数据库连接（需要 NUXT_SUPABASE_DB_URL）",
        )
    return factory


@asynccontextmanager
async def session_scope(user: AuthUser) -> AsyncIterator[AsyncSession]:
    """用户会话：一个事务，事务内先设好 RLS 身份。

    需要手动控制生命周期的地方（比如 SSE 之前做完 DB 操作就释放连接）
    用这个，而不是 Depends 版本。
    """
    async with _factory("app")() as session:
        async with session.begin():
            # set_config(..., is_local=true) 等价于 SET LOCAL，但可以用参数绑定
            await session.execute(
                text("select set_config('app.user_id', :uid, true)"),
                {"uid": str(user.id)},
            )
            yield session


async def get_session(user: CurrentUser) -> AsyncIterator[AsyncSession]:
    async with session_scope(user) as session:
        yield session


SessionDep = Annotated[AsyncSession, Depends(get_session)]


@asynccontextmanager
async def admin_session_scope() -> AsyncIterator[AsyncSession]:
    """管理会话：BYPASSRLS 角色，给后台任务/定时任务/指标写入用。"""
    async with _factory("admin")() as session:
        async with session.begin():
            yield session


async def get_admin_session() -> AsyncIterator[AsyncSession]:
    async with admin_session_scope() as session:
        yield session


AdminSessionDep = Annotated[AsyncSession, Depends(get_admin_session)]
