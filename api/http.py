"""统一的对外 HTTP 客户端。

为什么集中在一处：超时、代理策略这些参数散在每个模块里，出问题时要满仓库找。

这里还有一个具体的坑：**httpx 默认会读取系统/环境里的代理设置** ——
在 macOS 上连「系统设置 → 网络 → 代理」里配的那一份都会被读进来。
有些环境里那个代理连不通（比如对某些域名握手失败），
于是一个本来可以直连的域名会报 `ConnectError`，而且报错信息里只有一句
`httpcore.ConnectError`，完全看不出是代理在捣乱。

所以默认**不走**环境代理；确实需要走代理时，用 `NUXT_HTTP_TRUST_ENV=true` 打开。
"""

import httpx

from .config import get_settings


def make_client(timeout: float | httpx.Timeout = 30.0) -> httpx.AsyncClient:
    settings = get_settings()
    resolved = httpx.Timeout(timeout) if isinstance(timeout, (int, float)) else timeout
    return httpx.AsyncClient(timeout=resolved, trust_env=settings.http_trust_env)


_shared: httpx.AsyncClient | None = None


def shared_client() -> httpx.AsyncClient:
    """给上游模型接口复用的长连接客户端。

    每次请求都新建 client，会把 TLS 握手重做一遍 —— 实测每次大约 0.5 秒。
    检索链路里向量化和重排是两次独立调用，光握手就接近 1 秒，
    在「检索 4 秒」的占比里很明显。

    需要不同超时的调用点可以在单次请求上覆盖：`client.post(..., timeout=...)`。
    """
    global _shared
    if _shared is None or _shared.is_closed:
        _shared = make_client(httpx.Timeout(60.0, connect=10.0))
    return _shared


async def aclose() -> None:
    global _shared
    if _shared is not None and not _shared.is_closed:
        await _shared.aclose()
    _shared = None
