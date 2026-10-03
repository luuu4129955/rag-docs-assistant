import { createHash } from 'node:crypto'

/**
 * 调用 OpenAI 兼容的向量化接口。
 * 默认用硅基流动的 BAAI/bge-m3（1024 维）；换服务商时改 runtimeConfig 即可，
 * 但注意：换模型通常意味着维度变化，所有已存的向量都要重算。
 *
 * 外面包了一层缓存：同一段文本 + 同一个模型 → 同一个向量，
 * 没必要重复花时间和调用次数。缓存里只存「文本哈希 + 向量」，不存原文。
 */
function cacheKey(model: string, text: string) {
  return createHash('sha256').update(`${model}:${text}`).digest('hex')
}

export async function embedTexts(event: any, texts: string[]): Promise<number[][]> {
  const { embeddingKey, embeddingBase, embeddingModel } = useRuntimeConfig(event)
  const config = useRuntimeConfig(event)

  if (!embeddingKey) {
    throw createError({ statusCode: 500, statusMessage: '服务端未配置 NUXT_EMBEDDING_KEY' })
  }
  if (!texts.length) return []

  const model = String(embeddingModel || 'BAAI/bge-m3')
  const cacheOn = String(config.embeddingCache ?? true) !== 'false'
  const cacheDb = cacheOn ? supabaseServer(event) : null
  const keys = texts.map(t => cacheKey(model, t))
  const result: (number[] | null)[] = new Array(texts.length).fill(null)

  // ---------- 1. 先查缓存 ----------
  if (cacheDb) {
    try {
      const { data, error } = await cacheDb
        .from('embedding_cache')
        .select('key, embedding')
        .in('key', keys)
      if (error) throw new Error(error.message)
      const byKey = new Map((data ?? []).map((r: any) => [r.key, r.embedding]))
      keys.forEach((k, i) => {
        const hit = byKey.get(k)
        if (Array.isArray(hit)) result[i] = hit as number[]
      })
    }
    catch (e: any) {
      // 迁移没跑或缓存不可用都不该影响主流程
      logEvent('embedding.cache_read_failed', { message: e?.message || String(e) })
    }
  }

  const missing = texts
    .map((text, i) => ({ text, i }))
    .filter(x => !result[x.i])

  // ---------- 2. 只把没缓存的送去向量化 ----------
  let fresh: number[][] = []
  if (missing.length) {
    const base = String(embeddingBase || '').replace(/\/+$/, '')
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${String(embeddingKey).trim()}`,
      },
      body: JSON.stringify({
        model,
        input: missing.map(x => x.text),
        encoding_format: 'float',
      }),
    })

    if (!res.ok) {
      const detail = await res.text()
      console.error('[embedding] 上游报错', res.status, detail)
      throw createError({ statusCode: 502, statusMessage: '向量化接口调用失败', data: detail })
    }

    const data = await res.json()
    fresh = (data?.data ?? [])
      .slice()
      .sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0))
      .map((item: any) => item.embedding)

    if (fresh.length !== missing.length) {
      throw createError({
        statusCode: 502,
        statusMessage: `向量数量不匹配：期望 ${missing.length} 条，实际 ${fresh.length} 条`,
      })
    }

    missing.forEach((x, i) => {
      result[x.i] = fresh[i]
    })
  }

  // ---------- 3. 回写缓存 ----------
  if (cacheDb && missing.length) {
    try {
      await cacheDb.from('embedding_cache').upsert(
        missing.map((x, i) => ({
          key: keys[x.i],
          model,
          embedding: fresh[i],
        })),
        { onConflict: 'key' },
      )
    }
    catch (e: any) {
      logEvent('embedding.cache_write_failed', { message: e?.message || String(e) })
    }
  }

  logEvent('embedding.done', {
    total: texts.length,
    cached: texts.length - missing.length,
    computed: missing.length,
  })

  return result as number[][]
}
