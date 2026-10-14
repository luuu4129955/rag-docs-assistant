"""P0 冒烟测试。

直接用 ASGI transport 在进程内打 /health，不启端口 ——
这样在受限环境里也能跑，同时也是 CI 里最便宜的一道保险。
"""

import httpx
import pytest

from api.main import app


@pytest.mark.asyncio
async def test_health_reports_config_and_database_section():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health")

    assert res.status_code == 200
    body = res.json()

    # 口径与 TS 版的 /api/health 对齐
    expected = ("supabaseUrl", "supabaseServiceKey", "chatKey", "chatModel", "ragTopK", "ragThreshold")
    for key in expected:
        assert key in body, f"缺字段：{key}"

    # 新增的数据库连通性一节
    database = body["database"]
    assert isinstance(database, dict)
    for key in ("configured", "ok", "target", "latencyMs", "error"):
        assert key in database, f"database 缺字段：{key}"


@pytest.mark.asyncio
async def test_health_never_echoes_secret_values():
    """健康检查只报告布尔值，不能把密钥本身回显出来。"""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/health")

    body = res.json()
    assert isinstance(body["supabaseUrl"], bool)
    assert isinstance(body["supabaseServiceKey"], bool)
    assert isinstance(body["chatKey"], bool)
    assert isinstance(body["embeddingKey"], bool)
