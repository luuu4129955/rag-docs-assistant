/**
 * B 档迁移的切换开关：把 /api/* 转发给 Python 后端。
 *
 * 为什么用中间件而不是改造每个路由：
 *   - 前端一行都不用改，它仍然调用相对路径 /api/...
 *   - 回退只需要把环境变量关掉，不用改代码
 *   - 迁移期可以逐条加白名单（NUXT_PY_BACKEND_PATHS），
 *     任何时候停下来项目都是可用的
 *
 * 打开方式：
 *   NUXT_PY_BACKEND_URL=http://127.0.0.1:8000
 *   NUXT_PY_BACKEND_PATHS=/api/health,/api/auth   # 留空 = 全部转发
 *
 * 用 proxyRequest 而不是自己 fetch + pipe：它会把方法、请求头、请求体和
 * 响应头原样带过去，并且**是流式的** —— SSE 不会被缓冲成一坨。
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const base = String((config as Record<string, unknown>).pyBackendUrl || '').trim()

  // 没配就完全不介入，一切照旧走 Nitro 里的 TS 实现
  if (!base) return

  const path = event.path || ''
  if (!path.startsWith('/api/')) return

  const allow = String((config as Record<string, unknown>).pyBackendPaths || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
  if (allow.length && !allow.some(prefix => path.startsWith(prefix))) return

  const target = base.replace(/\/+$/, '') + path
  return proxyRequest(event, target)
})
