"""Docs QA 的 Python 后端（B 档迁移目标）。

分层约定（对应 MIGRATION-PYTHON.md 第 2 节）：
    config        配置（pydantic-settings）
    db            数据库连接与连接池
    security      鉴权（JWT 验签、JWKS）
    deps          FastAPI 依赖注入
    models        SQLAlchemy 模型
    schemas       Pydantic 入参/出参
    repositories  只写 SQL，不做业务判断
    services      业务逻辑（分块、检索、重排、缓存、限流）
    routers       HTTP 路由
"""
