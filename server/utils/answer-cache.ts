import { createHash } from 'node:crypto'

/**
 * 答案缓存：同一个问题 + 同一份语料 + 同一套参数 → 直接复用上次的回答，
 * 省掉「向量化 + 检索 + 重排 + 模型」这一整条链路。
 *
 * 关键不是"存起来"，而是**失效条件**：
 *   1) 语料变了（上传 / 重新分块 / 重新向量化）→ corpusVersion 变化 → 旧缓存自然失效
 *   2) 参数变了（换模型、调阈值、调 Top-K）→ 缓存键里带这些参数
 *   3) 时间太久 → TTL（默认 7 天）
 * 三者缺一，就会出现"用户已经更新了文档，回答还是旧的"这种最难查的问题。
 */

export function cacheKeyOf(parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

export function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * 语料版本：把该用户所有「就绪」文档的 id + 更新时间拼起来取哈希。
 * 任何一次上传或重新处理都会改 updated_at，于是版本变了、缓存失效。
 */
export async function corpusVersion(event: any, userId: string): Promise<string> {
  const db = supabaseAsUser(event)
  const { data, error } = await db
    .from('documents')
    .select('id, updated_at, status')
    .eq('user_id', userId)
    .eq('status', 'ready')

  if (error) {
    // 读不到就给个随机版本：宁可不用缓存，也不要返回过期答案
    logEvent('cache.corpus_version_failed', { message: error.message })
    return `unknown-${Date.now()}`
  }

  const fingerprint = (data ?? [])
    .map((d: any) => `${d.id}:${d.updated_at ?? ''}`)
    .sort()
    .join(';')

  return createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)
}

export type CachedAnswer = {
  answer: string
  sources: any[]
  usedCount: number
}

export async function readAnswerCache(
  event: any,
  key: string,
  ttlDays: number,
): Promise<CachedAnswer | null> {
  try {
    const db = supabaseServer(event)
    const { data, error } = await db
      .from('answer_cache')
      .select('answer, sources, used_count, created_at, hits')
      .eq('key', key)
      .maybeSingle()

    if (error) throw new Error(error.message)
    if (!data) return null

    const ageMs = Date.now() - new Date(data.created_at).getTime()
    if (ageMs > ttlDays * 24 * 3600 * 1000) return null

    // 命中计数 + 最近命中时间：以后想按"省了多少次调用"做统计就靠它
    await db.from('answer_cache')
      .update({ hits: (data.hits ?? 0) + 1, last_hit_at: new Date().toISOString() })
      .eq('key', key)

    return {
      answer: data.answer,
      sources: Array.isArray(data.sources) ? data.sources : [],
      usedCount: data.used_count ?? 0,
    }
  }
  catch (e: any) {
    logEvent('cache.read_failed', { message: e?.message || String(e) })
    return null
  }
}

export async function writeAnswerCache(
  event: any,
  row: {
    key: string
    userId: string
    question: string
    answer: string
    sources: any[]
    usedCount: number
    threshold: number
    model: string
    corpusVersion: string
  },
) {
  try {
    const db = supabaseServer(event)
    const { error } = await db.from('answer_cache').upsert({
      key: row.key,
      user_id: row.userId,
      question: row.question.slice(0, 500),
      answer: row.answer,
      sources: row.sources,
      used_count: row.usedCount,
      threshold: row.threshold,
      model: row.model,
      corpus_version: row.corpusVersion,
    }, { onConflict: 'key' })
    if (error) throw new Error(error.message)
  }
  catch (e: any) {
    logEvent('cache.write_failed', { message: e?.message || String(e) })
  }
}
