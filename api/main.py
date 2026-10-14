"""Docs QA 的 Python 后端（B 档）。

P0 阶段只有一件事：证明这条链路能起来——
    uvicorn 启动 → GET /health → 读配置 + 探数据库。

业务路由从 P3 开始逐条迁移；前端保持不变，
由 Nuxt 侧的转发白名单决定某个请求走 Python 还是走原来的 TS 实现。

本地启动（在 docs-qa/ 目录下）：
    .venv/bin/uvicorn api.main:app --reload --port 8000
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import db, http
from .routers import (
    auth,
    chat,
    conversations,
    documents,
    health,
    jobs,
    metrics,
    search,
    telemetry,
    upload,
)
from .routers import (
    eval as eval_router,
)
from .services import storage


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时故意不强制连库：配置缺失应该体现在 /health 的返回里，
    # 而不是让进程直接起不来（跟 TS 版 /api/health 的口径一致）。
    yield
    await db.dispose()
    await storage.aclose()
    await http.aclose()


app = FastAPI(title="Docs QA API", version="0.1.0", lifespan=lifespan)

# /health 给运维用；/api/health 跟 TS 版路径一致，方便前端白名单原样转发
app.include_router(health.router)
app.include_router(health.router, prefix="/api")

# 业务路由的 path 都自带 /api 前缀，和前端现有调用完全对齐
for _module in (
    auth,
    conversations,
    documents,
    upload,
    search,
    chat,
    jobs,
    metrics,
    telemetry,
    eval_router,
):
    app.include_router(_module.router)
