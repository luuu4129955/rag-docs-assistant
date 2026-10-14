/**
 * 前端错误上报入口（轻量版 Sentry）。
 *
 * 浏览器侧的异常（JS 报错、未处理的 Promise、接口 5xx、Vue 渲染错误）
 * 由 app/plugins/error-report.ts 收集后批量打到这里，落库到 client_errors。
 *
 * 为什么不直接引 Sentry：那要装 SDK、配 DSN、还要在浏览器里放一个公开 key。
 * 这里用「自己的接口 + 自己的表」，链路和项目其它部分一致，也顺带把
 * 「前端监控」这件事在面试里讲得清楚——重点是采集、聚合、告警这条链路，
 * 而不是某个具体 SDK 的名字。
 */
const MAX_EVENTS = 20
const MAX_MESSAGE = 500
const MAX_STACK = 4000

export default defineEventHandler(async (event) => {
  // 登录态是可选的：登录前（比如登录接口本身报错）也要能上报
  const token = bearerToken(event)
  let userId: string | null = null
  if (token) {
    try {
      userId = (await requireUser(event)).id
    }
    catch {
      userId = null
    }
  }

  const ip = getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  await enforceRateLimit(event, userId ?? ip, 'telemetry')

  const body = await readBody(event)
  const incoming = Array.isArray(body?.events) ? body.events.slice(0, MAX_EVENTS) : []
  if (!incoming.length) return { ok: true, accepted: 0 }

  const rows = incoming
    .filter((e: any) => e && typeof e.message === 'string' && e.message.trim())
    .map((e: any) => ({
      user_id: userId,
      kind: String(e.kind ?? 'js').slice(0, 24),
      message: String(e.message).slice(0, MAX_MESSAGE),
      source: e.source ? String(e.source).slice(0, 300) : null,
      stack: e.stack ? String(e.stack).slice(0, MAX_STACK) : null,
      url: e.url ? String(e.url).slice(0, 500) : null,
      user_agent: String(getHeader(event, 'user-agent') || '').slice(0, 300),
      meta: e.meta && typeof e.meta === 'object' ? e.meta : null,
    }))

  if (!rows.length) return { ok: true, accepted: 0 }

  const db = supabaseServer(event)
  const { error } = await db.from('client_errors').insert(rows)
  if (error) {
    // 迁移没跑时别把前端的错误上报也变成新错误，只记日志
    logEvent('telemetry.write_failed', { message: error.message })
    return { ok: false, accepted: 0 }
  }

  for (const row of rows) {
    logEvent('client_error', { userId, kind: row.kind, message: row.message, url: row.url })
  }

  return { ok: true, accepted: rows.length }
})
