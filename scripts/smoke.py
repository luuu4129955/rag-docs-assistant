"""Python 后端冒烟测试：不启端口，用 ASGI 在进程内打接口。

用法（在 docs-qa/ 目录下）：
    .venv/bin/python scripts/smoke.py
    EMAIL=you@example.com PASSWORD=xxx .venv/bin/python scripts/smoke.py   # 多测带鉴权的接口

不带账号时只测「不需要鉴权」的部分：
    /health 的数据库连通性、未登录请求应当被拒。

带账号时会多走一遍真实链路：登录 → /auth/me → 文档列表 → 会话列表
→ /search（会真的调向量化接口和数据库函数）→ 指标汇总。

**/search 这条最有价值**：它是唯一同时压到 `match_chunks` +
`search_chunks_keyword` + 向量化 + RRF 的路径，也就是异步驱动下
最容易出问题的地方。
"""

import asyncio
import os
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from api import db  # noqa: E402
from api.main import app  # noqa: E402

OK = "✅"
NG = "❌"


async def main() -> int:
    problems: list[str] = []
    transport = httpx.ASGITransport(app=app)

    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=60.0) as client:
        # ---------- 1. /health ----------
        res = await client.get("/health")
        health = res.json()
        db_info = health.get("database", {})
        if res.status_code == 200 and db_info.get("ok"):
            print(f"{OK} /health：数据库连通，延迟 {db_info.get('latencyMs')}ms（{db_info.get('target')}）")
        else:
            problems.append(f"/health 数据库不通：{db_info.get('error')}")
            print(f"{NG} /health：{db_info.get('error')}")

        # ---------- 2. 未登录必须被拒 ----------
        res = await client.get("/api/documents")
        if res.status_code == 401:
            print(f"{OK} 未登录访问 /api/documents → 401")
        else:
            problems.append(f"未登录访问 /api/documents 返回了 {res.status_code}，应为 401")
            print(f"{NG} 未登录访问 /api/documents → {res.status_code}")

        # ---------- 3. 带账号时跑完整链路 ----------
        # ---------- 3. 数据库函数回归：take_token ----------
        # 这个函数踩过「RETURN QUERY 之后没写 RETURN」的坑：会返回两行，
        # 调用方 .one() 报错，而且桶被第二次更新覆盖 —— 限流静默失效。
        # 这里不看代码、只看真实行为。
        admin_engine = db.engine("admin")
        if admin_engine is not None:
            try:
                async with admin_engine.connect() as conn:
                    async with conn.begin():
                        probe_key = f"smoke:{uuid4()}"
                        calls = []
                        for _ in range(3):
                            calls.append(
                                (
                                    await conn.execute(
                                        text(
                                            "select * from take_token(p_key => :k, "
                                            "p_capacity => :cap, p_refill_per_sec => :refill, "
                                            "p_cost => :cost)"
                                        ),
                                        {"k": probe_key, "cap": 2.0, "refill": 0.0, "cost": 1.0},
                                    )
                                ).all()
                            )
                shapes = [len(rows) for rows in calls]
                verdicts = [bool(rows[0].allowed) for rows in calls if rows]
                if shapes == [1, 1, 1] and verdicts == [True, True, False]:
                    print(f"{OK} take_token：容量 2 连取 3 次 → 允许/允许/拒绝，每行 1 条")
                else:
                    problems.append(f"take_token 行为异常：返回行数={shapes}，判定={verdicts}")
                    print(f"{NG} take_token：返回行数={shapes}，判定={verdicts}")
            except Exception as exc:  # noqa: BLE001
                problems.append(f"take_token 调用失败：{type(exc).__name__}: {str(exc)[:200]}")
                print(f"{NG} take_token 调用失败：{exc}")

        # ---------- 4. 带账号时跑完整链路 ----------
        email = os.environ.get("EMAIL", "").strip()
        password = os.environ.get("PASSWORD", "").strip()
        if not email or not password:
            print("ℹ️  未提供 EMAIL / PASSWORD，跳过需要鉴权的接口")
            return 1 if problems else 0

        res = await client.post("/api/auth/login", json={"email": email, "password": password})
        if res.status_code != 200:
            print(f"{NG} 登录失败：{res.status_code} {res.text[:200]}")
            return 2
        token = res.json()["session"]["accessToken"]
        auth = {"Authorization": f"Bearer {token}"}
        print(f"{OK} 登录成功（{email}）")

        res = await client.get("/api/auth/me", headers=auth)
        me = res.json()
        print(f"{OK} /auth/me → {me.get('email')}")

        res = await client.get("/api/documents", headers=auth)
        docs = res.json()
        print(f"{OK} /documents → {len(docs)} 份"
              + (f"，其中就绪 {sum(1 for d in docs if d.get('status') == 'ready')} 份" if docs else ""))

        res = await client.get("/api/conversations", headers=auth)
        print(f"{OK} /conversations → {len(res.json())} 个会话")

        res = await client.post("/api/search", headers=auth, json={"query": "代码分割", "k": 3})
        if res.status_code == 200:
            payload = res.json()
            hits = payload.get("results", [])
            top = f"，最高相似度 {hits[0]['similarity']:.3f}" if hits else ""
            print(
                f"{OK} /search → 召回 {len(hits)} 块{top}"
                f"（rerank={'开' if payload.get('rerank') else '关'}）"
            )
            if not hits:
                print("   ⚠️  检索没召回任何块 —— 确认文档已经向量化（embeddedCount > 0）")
        else:
            problems.append(f"/search 失败：{res.status_code} {res.text[:200]}")
            print(f"{NG} /search → {res.status_code} {res.text[:200]}")

        res = await client.get("/api/metrics/summary", headers=auth)
        if res.status_code == 200:
            print(f"{OK} /metrics/summary → 样本 {res.json().get('sampleSize')} 条")
        else:
            print(f"{NG} /metrics/summary → {res.status_code} {res.text[:150]}")

    print()
    if problems:
        print(f"{NG} 冒烟不通过：")
        for p in problems:
            print(f"   - {p}")
        return 1

    print(f"{OK} 冒烟通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
