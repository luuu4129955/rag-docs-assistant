/**
 * 引用信息要跟着消息一起存：只存正文的话，刷新后 [1] 还在、点开却没内容。
 * 这里顺手做两件事：限制条数与单条长度（防止有人往 jsonb 里灌垃圾），
 * 以及在没有 sources 列的库上优雅降级（老库没跑迁移也不至于存不了消息）。
 */
function normalizeCitations(input: any) {
  if (!input || typeof input !== 'object') return null
  const list = Array.isArray(input.sources) ? input.sources : []
  if (!list.length) return null

  return {
    sources: list.slice(0, 20).map((s: any, i: number) => ({
      n: Number(s?.n) || i + 1,
      filename: String(s?.filename ?? '').slice(0, 200),
      idx: Number(s?.idx) || 0,
      similarity: Number(s?.similarity) || 0,
      content: String(s?.content ?? '').slice(0, 2000),
    })),
    usedCount: Number(input.usedCount) || 0,
    threshold: Number(input.threshold) || 0,
  }
}

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const role = body?.role
  const content = typeof body?.content === 'string' ? body.content : ''
  const citations = normalizeCitations(body?.citations)

  if (!conversationId) throw createError({ statusCode: 400, statusMessage: 'conversationId 必填' })
  if (!['system', 'user', 'assistant'].includes(role)) {
    throw createError({ statusCode: 400, statusMessage: 'role 不合法' })
  }
  if (!content.trim()) throw createError({ statusCode: 400, statusMessage: 'content 不能为空' })

  const db = supabaseServer(event)

  const insert = (payload: Record<string, unknown>) => db
    .from('messages')
    .insert(payload)
    .select()
    .single()

  let { data, error } = await insert({ conversation_id: conversationId, role, content, sources: citations })

  // 库上还没有 sources 列时（没跑 alter table），退回旧字段重试一次
  if (error && /sources/.test(error.message ?? '')) {
    console.warn('[messages] 库上没有 sources 列，本次只存正文。建议执行：alter table messages add column if not exists sources jsonb;')
    ;({ data, error } = await insert({ conversation_id: conversationId, role, content }))
  }

  if (error) {
    console.error('[messages] 保存消息失败', error)
    throw createError({ statusCode: 500, statusMessage: '保存消息失败', data: error.message })
  }
  return data
})
