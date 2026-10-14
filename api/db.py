"""数据库连接。

B 档的关键变化：不再经过 PostgREST，改用 SQLAlchemy + asyncpg 直连 Postgres。

两个角色、两个 engine（见 MIGRATION-PYTHON.md 3.1）：
    app    非所有者角色，受 RLS 约束 —— 所有面向用户的请求
    admin  BYPASSRLS 角色 —— 后台任务、定时任务、指标写入

**这里有一个必须记住的坑**：PostgreSQL 里表的所有者默认绕过 RLS。
如果用所有者账号直连，隔离会静默失效（查询照常返回，但不隔离）。
所以连接串里的角色必须是对的 —— 这件事在 P1 会加专项验证。

P0 只做：建 engine + 探连通性。把 user_id 放进事务上下文（SET LOCAL）
是 P1 的工作，不在这一步。
"""

import asyncio
import socket
import time
from urllib.parse import urlsplit

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from .config import get_settings

_engines: dict[str, AsyncEngine] = {}
_sessionmakers: dict[str, async_sessionmaker[AsyncSession]] = {}


def to_asyncpg_url(url: str) -> str:
    """把 postgres:// / postgresql:// 统一成 asyncpg 驱动形式；已带驱动的原样返回。"""
    raw = url.strip()
    if "+asyncpg://" in raw or "+psycopg://" in raw:
        return raw
    for prefix in ("postgresql://", "postgres://"):
        if raw.startswith(prefix):
            return "postgresql+asyncpg://" + raw[len(prefix) :]
    return raw


def redact(url: str) -> str | None:
    """脱敏形式：只保留 host / port / 库名，永远不带密码。"""
    if not url.strip():
        return None
    try:
        parts = urlsplit(to_asyncpg_url(url))
        database = (parts.path or "/").lstrip("/") or "postgres"
        return f"{parts.hostname or '?'}:{parts.port or 5432}/{database}"
    except Exception:
        return "?"


def _resolve_url(role: str) -> str:
    settings = get_settings()
    return settings.db_url if role == "app" else settings.db_admin_url


def _assert_filled(url: str, role: str) -> None:
    """把「模板没替换完」这种低级错误变成一句人话。

    典型症状：直接复制模板得到 `...@db.xxx.supabase.co:<port>/postgres`，
    然后报一句 `invalid literal for int() with base 10: '<port>'` —— 看不出该改什么。
    """
    if "<" in url or ">" in url:
        hint = "端口填 5432；如果是 Session pooler，主机里的 <region> 也要换成真实地区"
        raise ValueError(
            f"{role} 角色的连接串里还有尖括号占位符（例如 <port> / <region>），"
            f"说明是从模板复制来、没替换完。{hint}。"
        )
    if "CHANGE_ME" in url:
        raise ValueError(
            f"{role} 角色的连接串还在用 sql/07 里的占位口令，"
            "请先用 `alter role ... password '...'` 设一个真实口令。"
        )


def engine(role: str = "app") -> AsyncEngine | None:
    """按角色取 engine（懒建）。没配连接串时返回 None，由调用方决定怎么报错。"""
    url = _resolve_url(role)
    if not url:
        return None
    _assert_filled(url, role)
    if role not in _engines:
        _engines[role] = create_async_engine(
            to_asyncpg_url(url),
            pool_pre_ping=True,
            pool_size=5,
            max_overflow=5,
            pool_recycle=1800,
            # Supabase 的 transaction 模式池化器与 asyncpg 的 prepared statement 冲突，
            # 关掉语句缓存即可兼容；走直连时也无害。
            connect_args={"statement_cache_size": 0},
        )
    return _engines[role]


def session_factory(role: str = "app") -> async_sessionmaker[AsyncSession] | None:
    eng = engine(role)
    if eng is None:
        return None
    if role not in _sessionmakers:
        _sessionmakers[role] = async_sessionmaker(eng, expire_on_commit=False)
    return _sessionmakers[role]


# 5 秒对「首次经过连接池」来说太紧：Supavisor 建连 + TLS 握手冷启动经常超过 5 秒，
# 之后的请求反而是快的。留 10 秒，避免健康检查把正常情况报成故障。
async def check_connectivity(role: str = "app", timeout_s: float = 10.0) -> dict:
    """探一次连通性。返回值会直接进 /health，所以只放脱敏信息和错误原因。"""
    url = _resolve_url(role)
    if not url:
        return {
            "configured": False,
            "ok": False,
            "target": None,
            "latencyMs": None,
            "error": "未配置 SUPABASE_DB_URL（直连需要数据库密码，service key 不能当密码用）",
        }

    started = time.perf_counter()

    try:
        eng = engine(role)

        async def _ping() -> None:
            async with eng.connect() as conn:
                await conn.execute(text("select 1"))

        await asyncio.wait_for(_ping(), timeout=timeout_s)
    except TimeoutError:
        return {
            "configured": True,
            "ok": False,
            "target": redact(url),
            "latencyMs": None,
            "error": f"连接超时（>{timeout_s}s）",
        }
    except Exception as exc:  # noqa: BLE001 —— 探活要把任何失败都变成可读信息
        hint = ""
        if isinstance(exc, socket.gaierror):
            hint = (
                " ｜ 域名解析失败：新版 Supabase 项目的 db.<ref>.supabase.co 常常没有 IPv4 记录，"
                "改用 Session pooler —— 主机换成 aws-0-<region>.pooler.supabase.com:5432，"
                "用户名换成 <角色>.<项目ref>（例如 app_rls.cxgobbmwusihnfffpkzp）"
            )
        return {
            "configured": True,
            "ok": False,
            "target": redact(url),
            "latencyMs": round((time.perf_counter() - started) * 1000),
            "error": f"{type(exc).__name__}: {str(exc)[:300]}{hint}",
        }

    return {
        "configured": True,
        "ok": True,
        "target": redact(url),
        "latencyMs": round((time.perf_counter() - started) * 1000),
        "error": None,
    }


async def dispose() -> None:
    """进程退出时把连接池收干净。"""
    for eng in _engines.values():
        await eng.dispose()
    _engines.clear()
    _sessionmakers.clear()
