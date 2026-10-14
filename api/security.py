"""鉴权：验签 Supabase 签发的 JWT。

两条路径：
  · JWKS（推荐）：从 `<supabase_url>/auth/v1/.well-known/jwks.json` 拉公钥，
    支持密钥轮换；公钥会被缓存住，不会每个请求都去拉。
  · HS256：配了 `SUPABASE_JWT_SECRET` 就用对称密钥验签。

**必须真的验签，不能只 decode。** 前端传来的东西一律不可信 ——
自己解析 JWT 就算数，等于任何人都能伪造别人的身份。

另外校验 `aud`（Supabase 的用户 token 是 `authenticated`）和过期时间。
"""

import time
from dataclasses import dataclass
from uuid import UUID

import jwt
from fastapi import HTTPException, status

from .config import Settings, get_settings
from .http import shared_client
from .log import log_event


@dataclass(frozen=True)
class AuthUser:
    id: UUID
    email: str | None = None


def bearer_token(authorization: str | None) -> str:
    """从 `Authorization: Bearer xxx` 里取出 token。"""
    if not authorization:
        return ""
    parts = authorization.split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1].strip()
    return ""


def _jwks_url(settings: Settings) -> str:
    return f"{settings.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"


# 公钥缓存：kid -> PyJWK，外加整体 TTL。密钥轮换时靠「找不到 kid 就强刷」兜底。
_JWKS_TTL_SECONDS = 300.0
_jwks_cache: dict[str, tuple[float, jwt.PyJWKSet]] = {}


async def _load_jwks(settings: Settings, force: bool = False) -> jwt.PyJWKSet:
    """取 Supabase 的 JWKS 公钥集。

    **不用 PyJWT 的 PyJWKClient**：它内部走 urllib，会读取系统/环境代理设置，
    在有些环境里那个代理根本连不通，报出来的是
    `<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING]>` ——
    而这个异常在我们的代码里会被翻译成 401，看起来像"用户登录失效"，
    排查方向完全被带偏。用自己的 HTTP 客户端取，行为和其他上游调用一致。
    """
    url = _jwks_url(settings)
    now = time.monotonic()
    cached = _jwks_cache.get(url)
    if not force and cached is not None and now - cached[0] < _JWKS_TTL_SECONDS:
        return cached[1]

    res = await shared_client().get(url, timeout=10.0)
    res.raise_for_status()
    key_set = jwt.PyJWKSet.from_dict(res.json())
    _jwks_cache[url] = (now, key_set)
    return key_set


async def _signing_key(token: str, settings: Settings):
    """按 token 头里的 kid 找到对应公钥。"""
    kid = jwt.get_unverified_header(token).get("kid")
    key_set = await _load_jwks(settings)

    if kid:
        # PyJWKSet.keys 是 list[PyJWK]，不是 dict；kid 在 PyJWK.key_id 上
        jwk = next((k for k in key_set.keys if k.key_id == kid), None)
        if jwk is None:
            # 可能是密钥轮换了，强刷一次再找
            key_set = await _load_jwks(settings, force=True)
            jwk = next((k for k in key_set.keys if k.key_id == kid), None)
        if jwk is None:
            raise jwt.InvalidTokenError("JWKS 里找不到 token 对应的 kid")
        return jwk.key

    if len(key_set.keys) == 1:
        return key_set.keys[0].key
    raise jwt.InvalidTokenError("token 缺少 kid，且 JWKS 里有多把密钥")


async def verify_token(token: str, settings: Settings) -> dict:
    audience = settings.supabase_jwt_audience or None
    require = {"require": ["exp", "sub"]}

    if settings.supabase_jwt_secret:
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience=audience,
            options=require,
        )

    if not settings.supabase_url:
        raise HTTPException(status_code=500, detail="服务端未配置 Supabase，无法验签")

    signing_key = await _signing_key(token, settings)
    return jwt.decode(
        token,
        signing_key,
        algorithms=["RS256", "ES256", "EdDSA"],
        audience=audience,
        options=require,
    )


async def current_user(authorization: str | None) -> AuthUser:
    """把 Authorization 头解析成 AuthUser；任何问题都按 401 处理。"""
    settings = get_settings()
    token = bearer_token(authorization)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录")

    try:
        claims = await verify_token(token, settings)
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录") from None
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail=f"无效的登录凭证（{type(exc).__name__}）") from None
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 —— JWKS 拉取失败等都要变成 401 而不是 500
        log_event("auth.verify_failed", message=str(exc)[:200])
        raise HTTPException(status_code=401, detail="登录凭证校验失败") from None

    sub = claims.get("sub")
    if not sub:
        raise HTTPException(status_code=401, detail="登录凭证缺少 sub")
    try:
        uid = UUID(str(sub))
    except ValueError:
        raise HTTPException(status_code=401, detail="登录凭证的 sub 不是合法 UUID") from None

    email = claims.get("email")
    return AuthUser(id=uid, email=str(email) if email else None)
