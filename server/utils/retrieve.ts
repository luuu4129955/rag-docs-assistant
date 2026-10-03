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
  /** 关键词那一路命中了几个词 */
  keywordHits?: number
  /** 这一块是被哪一路找到的：vector / keyword / 两者都有 */
  foundBy?: string[]
  /** RRF 融合分（只用于排序，不是相似度） */
  fusionScore?: number
  /** 重排序分数：向量不够用时，用它决定谁进 prompt。未启用重排序时为 null */
  rerankScore?: number | null
}

// RRF（Reciprocal Rank Fusion）里的平滑常数：经验值 60，
// 作用是让"第一名和第 100 名"的差距不要过于悬殊，避免单路结果一票独大
const RRF_K = 60

type RankedList = { tag: string, items: RetrievedChunk[] }

/**
 * RRF 融合：不看分数、只看名次。
 * 每路各排各的，最后把名次加起来（1/(k+rank) 累加）再排序。
 * 好处是不需要把"余弦相似度"和"关键词命中数"这两种量纲不同的分数强行归一化。
 */
function fuseByRrf(lists: RankedList[], limit: number): RetrievedChunk[] {
  const acc = new Map<string, { item: RetrievedChunk, score: number, tags: Set<string> }>()

  for (const { tag, items } of lists) {
    items.forEach((item, i) => {
      const key = `${item.document_id}#${item.idx}`
      const entry = acc.get(key) ?? { item: { ...item }, score: 0, tags: new Set<string>() }
      entry.score += 1 / (RRF_K + i + 1)
      entry.tags.add(tag)
      // 两路都命中时，保留向量分与关键词命中数，便于调试面板展示
      if (item.similarity) entry.item.similarity = item.similarity
      if (item.keywordHits) entry.item.keywordHits = item.keywordHits
      acc.set(key, entry)
    })
  }

  return [...acc.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => ({ ...e.item, foundBy: [...e.tags], fusionScore: e.score }))
}

/** 关键词那一路：交给数据库的 search_chunks_keyword，按命中词数排序 */
async function keywordSearch(
  event: any,
  owner: string,
  query: string,
  limit: number,
): Promise<RetrievedChunk[]> {
  const db = supabaseAsUser(event)
  const { data, error } = await db.rpc('search_chunks_keyword', {
    p_query: query,
    p_limit: limit,
    p_owner: owner,
  })
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: any) => ({
    id: r.id,
    document_id: r.document_id,
    filename: r.filename,
    idx: r.idx,
    content: r.content,
    // 关键词那一路没有余弦相似度，置 0；排序交给 RRF 和 reranker
    similarity: 0,
    keywordHits: r.hits,
  }))
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
  options: { hybrid?: boolean } = {},
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

  let candidates = ((data ?? []) as RetrievedChunk[]).map(c => ({ ...c, foundBy: ['vector'] }))

  // 关键词那一路：函数还没建（迁移没跑）时自动跳过，不影响主流程
  // options.hybrid 只给调试/对照实验用：传 false 就只走向量那一路
  const hybridOn = options.hybrid ?? (String(config.hybridEnabled ?? true) !== 'false')
  if (hybridOn) {
    try {
      const keywordHits = await keywordSearch(event, owner, query, recallSize)
      if (keywordHits.length) {
        candidates = fuseByRrf(
          [{ tag: 'vector', items: candidates }, { tag: 'keyword', items: keywordHits }],
          recallSize,
        )
      }
    }
    catch (e: any) {
      logEvent('retrieve.keyword_failed', { message: e?.message || String(e) })
    }
  }

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
