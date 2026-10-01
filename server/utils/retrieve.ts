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
}

export async function retrieveChunks(
  event: any,
  query: string,
  k: number,
): Promise<RetrievedChunk[]> {
  // 问题和分块必须用同一个模型向量化，否则两个向量不在同一个空间里
  const [vector] = await embedTexts(event, [query])
  const db = supabaseServer(event)

  const { data, error } = await db.rpc('match_chunks', {
    query_embedding: JSON.stringify(vector),
    match_count: k,
  })

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '检索失败', data: error.message })
  }

  return (data ?? []) as RetrievedChunk[]
}
