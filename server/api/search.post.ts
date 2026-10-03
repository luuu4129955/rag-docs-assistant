/**
 * 检索调试接口：返回的就是聊天接口真正会用的那批分块（含重排序分数）。
 * 之所以复用 retrieveChunks 而不是自己写一遍查询，是为了让调试面板
 * 和线上行为完全一致——否则调出来的结果没有参考价值。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const body = await readBody(event)
  const query = typeof body?.query === 'string' ? body.query.trim() : ''
  const rawK = Number(body?.k)
  const k = Number.isFinite(rawK) ? Math.min(Math.max(Math.trunc(rawK), 1), 20) : 5

  if (!query) {
    throw createError({ statusCode: 400, statusMessage: 'query 不能为空' })
  }

  const config = useRuntimeConfig(event)
  // 调试面板可以传 hybrid:false 做对照（关掉关键词那一路）
  const hybrid = typeof body?.hybrid === 'boolean' ? body.hybrid : undefined
  const results = await retrieveChunks(event, user.id, query, k, { hybrid })

  return {
    query,
    k,
    // 向量阈值：重排序关闭时，拒答靠它
    threshold: Number(config.ragThreshold) || 0.35,
    rerank: rerankConfigured(event),
    // 重排序阈值：未标定时为 0（表示不参与判定，只看排序）
    rerankThreshold: Number(config.rerankThreshold) || 0,
    results,
  }
})
