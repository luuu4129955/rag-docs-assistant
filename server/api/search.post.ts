export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const rawK = Number(body?.k)
  const k = Number.isFinite(rawK) ? Math.min(Math.max(Math.trunc(rawK), 1), 20) : 5

  if (!query) {
    throw createError({ statusCode: 400, statusMessage: 'query 不能为空' })
  }

  // 检索用的是"问题"的向量，必须和入库时用同一个模型
  const [vector] = await embedTexts(event, [query])

  const db = supabaseServer(event)
  const { data, error } = await db.rpc('match_chunks', {
    query_embedding: JSON.stringify(vector),
    match_count: k,
  })

  if (error) {
    console.error('[search] 检索失败', error)
    throw createError({ statusCode: 500, statusMessage: '检索失败', data: error.message })
  }

  // 带上聊天接口用的阈值：调试面板不做过滤，但要让调用方知道哪些块会被采用
  const config = useRuntimeConfig(event)
  const threshold = Number(config.ragThreshold) || 0.35

  return { query, k, threshold, results: data ?? [] }
})
