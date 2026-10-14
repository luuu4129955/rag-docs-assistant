"""P1 隔离验证：证明「直连 Postgres 也一样受 RLS 约束」。

用法（在 docs-qa/ 目录下）：
    .venv/bin/python scripts/verify_rls.py

为什么需要这个脚本：RLS 失效是**静默**的 —— 查询照常返回结果，
只是把不该看见的数据也返回了，没有任何报错。所以不能靠"接口能跑"来判断，
必须拿数据亲自证一遍。

四步检查：
  1) app 角色本身不能带 BYPASSRLS（带了就白搭）
  2) 不设身份查 documents / chunks —— 必须是 0 行（fail-closed）
  3) 设成真实用户后再查 —— 只能看到他自己那部分
  4) 换一个用户再查 —— 结果不同，说明确实是按人隔离
任何一步不符合预期都以非零退出码结束。
"""

import asyncio
import sys
from pathlib import Path

# 让 `python scripts/verify_rls.py` 也能 import 到 api 包
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncConnection  # noqa: E402

from api import db  # noqa: E402

OK = "✅"
NG = "❌"


async def _scalar(conn: AsyncConnection, sql: str, params: dict | None = None):
    return (await conn.execute(text(sql), params or {})).scalar_one()


async def _count(conn: AsyncConnection, table: str, where: str = "", params: dict | None = None) -> int:
    sql = f"select count(*) from {table}" + (f" where {where}" if where else "")
    return int(await _scalar(conn, sql, params))


async def main() -> int:
    try:
        app_engine = db.engine("app")
        admin_engine = db.engine("admin")
    except Exception as exc:  # noqa: BLE001 —— 连接串本身有问题时给一句人话
        print(f"{NG} 连接串有问题：{exc}")
        return 2
    if app_engine is None or admin_engine is None:
        print(f"{NG} 未配置数据库连接串")
        print("   NUXT_SUPABASE_DB_URL（app_rls）和 NUXT_SUPABASE_DB_ADMIN_URL（app_admin）都要配")
        return 2

    problems: list[str] = []

    # ---------- 0. 先确认能连上 ----------
    # 走 check_connectivity 而不是自己 connect：这样「模板没替换」「域名解析不了」
    # 这类提示只维护一份，/health 和本脚本看到的是同一句话。
    for role_name in ("app", "admin"):
        health = await db.check_connectivity(role_name)
        if not health.get("ok"):
            print(f"{NG} {role_name} 连不上：{health.get('error')}")
            return 2

    async with app_engine.connect() as conn:
        role = await _scalar(conn, "select current_user")
        bypass = await _scalar(
            conn, "select rolbypassrls from pg_roles where rolname = current_user"
        )

    print(f"app 连接角色：{role}")

    # ---------- 1. 角色不能自带 BYPASSRLS ----------
    if bypass:
        problems.append(
            f"app 角色 `{role}` 带 BYPASSRLS —— RLS 完全不会生效。"
            "请改用 app_rls（非所有者、非 BYPASSRLS）连接。"
        )
        print(f"{NG} 第 1 步：role 带 BYPASSRLS")
    else:
        print(f"{OK} 第 1 步：app 角色不带 BYPASSRLS")

    # ---------- 用 admin 找两个真实用户，作为对照 ----------
    async with admin_engine.connect() as conn:
        users = (
            await conn.execute(
                text(
                    "select user_id, count(*) as n from documents "
                    "where user_id is not null group by user_id order by n desc limit 2"
                )
            )
        ).all()

    if not users:
        print(f"{OK} 第 2~4 步：库里还没有任何文档，跳过隔离对照（先上传一份再跑一次）")
        return 1 if problems else 0

    user_a = users[0].user_id
    user_b = users[1].user_id if len(users) > 1 else None

    # ---------- 2. 不设身份：必须查不到 ----------
    async with app_engine.connect() as conn:
        async with conn.begin():
            docs = await _count(conn, "documents")
            chunks = await _count(conn, "chunks")

    if docs == 0 and chunks == 0:
        print(f"{OK} 第 2 步：不设身份时 documents=0、chunks=0（fail-closed）")
    else:
        problems.append(
            f"不设身份却读到了数据（documents={docs}, chunks={chunks}）—— 隔离没有生效"
        )
        print(f"{NG} 第 2 步：不设身份读出 documents={docs}、chunks={chunks}")

    # ---------- 3. 设成用户 A：只能看到 A 的 ----------
    async with admin_engine.connect() as conn:
        expected_a_docs = await _count(conn, "documents", "user_id = :uid", {"uid": str(user_a)})

    async with app_engine.connect() as conn:
        async with conn.begin():
            await conn.execute(
                text("select set_config('app.user_id', :uid, true)"), {"uid": str(user_a)}
            )
            docs_a = await _count(conn, "documents")
            foreign = await _count(conn, "documents", "user_id <> :uid", {"uid": str(user_a)})

    if docs_a == expected_a_docs and foreign == 0:
        print(f"{OK} 第 3 步：以用户 A 身份只看到自己的 {docs_a} 份文档，别人的 0 份")
    else:
        problems.append(
            f"以用户 A 身份：看到 {docs_a} 份（应为 {expected_a_docs}），其中不属于 A 的有 {foreign} 份"
        )
        print(f"{NG} 第 3 步：docs={docs_a}（应为 {expected_a_docs}）、混入他人 {foreign} 份")

    # ---------- 4. 换用户 B：结果应当不同 ----------
    if user_b is not None:
        async with app_engine.connect() as conn:
            async with conn.begin():
                await conn.execute(
                    text("select set_config('app.user_id', :uid, true)"), {"uid": str(user_b)}
                )
                docs_b = await _count(conn, "documents")
        if docs_b != docs_a:
            print(f"{OK} 第 4 步：换成用户 B 看到 {docs_b} 份，与 A 的 {docs_a} 份不同")
        else:
            print(f"⚠️  第 4 步：A 和 B 都看到 {docs_a} 份 —— 可能是巧合（两人文档数相同），确认一下")
    else:
        print("ℹ️  第 4 步：库里只有一个用户，跳过对照")

    print()
    if problems:
        print(f"{NG} 隔离验证不通过：")
        for p in problems:
            print(f"   - {p}")
        return 1

    print(f"{OK} 隔离验证通过：直连也在 RLS 约束之下")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
