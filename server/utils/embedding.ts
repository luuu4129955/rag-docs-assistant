/**
 * 调用 OpenAI 兼容的向量化接口。
 * 默认用硅基流动的 BAAI/bge-m3（1024 维）；换服务商时改 runtimeConfig 即可，
 * 但注意：换模型通常意味着维度变化，所有已存的向量都要重算。
 */
export async function embedTexts(event: any, texts: string[]): Promise<number[][]> {
  const { embeddingKey, embeddingBase, embeddingModel } = useRuntimeConfig(event)

  if (!embeddingKey) {
    throw createError({ statusCode: 500, statusMessage: '服务端未配置 NUXT_EMBEDDING_KEY' })
  }
  if (!texts.length) return []

  const base = String(embeddingBase || '').replace(/\/+$/, '')
  const res = await fetch(`${base}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(embeddingKey).trim()}`,
    },
    body: JSON.stringify({
      model: embeddingModel,
      input: texts,
      encoding_format: 'float',
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    console.error('[embedding] 上游报错', res.status, detail)
    throw createError({ statusCode: 502, statusMessage: '向量化接口调用失败', data: detail })
  }

  const data = await res.json()
  const vectors: number[][] = (data?.data ?? [])
    .slice()
    .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
    .map((item: any) => item.embedding)

  if (vectors.length !== texts.length) {
    throw createError({
      statusCode: 502,
      statusMessage: `向量数量不匹配：期望 ${texts.length} 条，实际 ${vectors.length} 条`,
    })
  }

  return vectors
}
