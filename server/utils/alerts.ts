/**
 * 告警出口：死信、上游持续报错这类「需要有人知道」的事件走这里。
 *
 * 配了 NUXT_ALERT_WEBHOOK 就把事件 POST 过去（飞书 / 钉钉 / Slack 的机器人
 * 都接受 JSON，字段名各家略有不同，这里用 content + text 双写兼容）；
 * 没配就只打结构化日志，不至于因为没配 webhook 就把事件丢掉。
 *
 * 一定要 fire-and-forget：告警本身不该拖慢、更不该拖垮主流程。
 */
export function alert(title: string, data: Record<string, unknown> = {}) {
  const payload = { ts: new Date().toISOString(), title, ...data }

  // 无论有没有 webhook，都先落一条结构化日志（平台日志里能直接搜 alert）
  logEvent('alert', payload)

  const webhook = String(process.env.NUXT_ALERT_WEBHOOK || '').trim()
  if (!webhook) return

  const text = `【Docs QA 告警】${title}\n${JSON.stringify(data)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  void fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg_type: 'text', content: { text }, text }),
    signal: controller.signal,
  })
    .catch((e: any) => logEvent('alert.webhook_failed', { message: e?.message || String(e) }))
    .finally(() => clearTimeout(timer))
}
