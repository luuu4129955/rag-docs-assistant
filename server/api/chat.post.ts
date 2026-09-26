const MAX_TURNS = 20
const MAX_CHARS = 4000

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const raw = Array.isArray(body?.messages) ? body.messages : []

  // 前端传来的内容一律不可信：过滤掉非法角色，限制条数和单条长度
  const messages = raw
    .filter((m: any) =>
      m && typeof m.content === 'string'
      && ['system', 'user', 'assistant'].includes(m.role))
    .slice(-MAX_TURNS)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))

  if (!messages.length) {
    throw createError({ statusCode: 400, statusMessage: 'messages 不能为空' })
  }

  const { deepseekKey } = useRuntimeConfig(event)
  if (!deepseekKey) {
    throw createError({ statusCode: 500, statusMessage: '服务端未配置 NUXT_DEEPSEEK_KEY' })
  }

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, stream: true, temperature: 0.3 }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text()
    console.error('[chat] 上游报错', res.status, detail)
    throw createError({ statusCode: res.status || 500, statusMessage: '模型接口调用失败', data: detail })
  }

  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache')
  return res.body
})
