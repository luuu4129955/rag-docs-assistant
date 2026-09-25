export default defineEventHandler(async (event) => {
  const { messages } = await readBody(event)
  const { deepseekKey } = useRuntimeConfig(event)

  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages, stream: true, temperature: 0.3 }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text()
    throw createError({ statusCode: res.status || 500, statusMessage: '模型接口调用失败', data: detail })
  }

  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache')
  return res.body
})