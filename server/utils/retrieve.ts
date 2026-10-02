/**
 * 检索：把问题向量化，再交给数据库里的 match_chunks 找最接近的分块。
 * 和 /api/search 用的是同一套逻辑，区别是这里给「回答」用，入参已经校验过。
 */
export type RetrievedChunk = {
  id: number
  document_id: string
  filename: string
  idx: number
  content: string
  similarity: number
  /** 重排序分数：向量不够用时，用它决定谁进 prompt。未启用重排序时为 null */
  rerankScore?: number | null
}

/**
 * 两段式检索：
 *   1) 向量检索粗召回 Top-N（默认 20）
 *   2) reranker 精排，取前 k 块
 *
 * 重排序失败不致命——降级成「只用向量结果」，并在日志里留痕。
 */
export async function retrieveChunks(
  event: any,
  owner: string,
  query: string,
  k: number,
): Promise<RetrievedChunk[]> {
  const config = useRuntimeConfig(event)
  // 问题和分块必须用同一个模型向量化，否则两个向量不在同一个空间里
  const [vector] = await embedTexts(event, [query])
  // 用「用户身份」的客户端：RLS 会保证只能召回自己的文档分块
  const db = supabaseAsUser(event)

  const recallSize = Math.max(k, Number(config.rerankTopN) || 20)
  const { data, error } = await db.rpc('match_chunks', {
    query_embedding: JSON.stringify(vector),
    match_count: recallSize,
    // 显式限定归属：RLS 是第一道，这里是第二道，防止任何配置疏漏导致跨用户召回
    owner,
  })

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '检索失败', data: error.message })
  }

  const candidates = (data ?? []) as RetrievedChunk[]
  if (candidates.length <= 1 || !rerankConfigured(event)) {
    return candidates.slice(0, k)
  }

  try {
    const ranked = await rerankTexts(event, query, candidates.map(c => c.content), candidates.length)
    if (!ranked.length) return candidates.slice(0, k)
    const scoreOf = new Map(ranked.map(r => [r.index, r.score]))
    return candidates
      .map((c, i) => ({ ...c, rerankScore: scoreOf.get(i) ?? null }))
      .sort((a, b) => (b.rerankScore ?? Number.NEGATIVE_INFINITY) - (a.rerankScore ?? Number.NEGATIVE_INFINITY))
      .slice(0, k)
  }
  catch (e: any) {
    logEvent('retrieve.rerank_failed', { message: e?.message || String(e) })
    return candidates.slice(0, k)
  }
}
