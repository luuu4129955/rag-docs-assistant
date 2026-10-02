/**
 * 线上指标汇总：给页面上的「评测」面板用。
 *
 * 只取最近 500 条、在应用层算分位数——样本量小的时候够用，
 * 数据涨上去应该换成数据库聚合或专门的指标系统（这也是盘点里记的取舍）。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = supabaseAsUser(event)

  const { data, error } = await db
    .from('chat_metrics')
    .select('retrieval_ms, first_token_ms, total_ms, prompt_tokens, completion_tokens, retrieved_count, used_count, refused, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    // 迁移没跑时给一句人话
    const hint = /chat_metrics|relation/.test(error.message ?? '') ? '（数据库还没执行 sql/03-metrics.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `读取指标失败${hint}`, data: error.message })
  }

  const rows = (data ?? []) as any[]
  const nums = (arr: number[]) => arr.filter(n => Number.isFinite(n)).sort((a, b) => a - b)
  const quantile = (arr: number[], q: number) => {
    if (!arr.length) return null
    const pos = (arr.length - 1) * q
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return Math.round(arr[lo] + (arr[hi] - arr[lo]) * (pos - lo))
  }
  const mean = (arr: number[]) => (arr.length ? Math.round(arr.reduce((s, n) => s + n, 0) / arr.length) : null)

  const total = nums(rows.map(r => r.total_ms))
  const first = nums(rows.map(r => r.first_token_ms))
  const retrieval = nums(rows.map(r => r.retrieval_ms))
  const refusedCount = rows.filter(r => r.refused).length
  const promptTokens = rows.reduce((s, r) => s + (r.prompt_tokens ?? 0), 0)
  const completionTokens = rows.reduce((s, r) => s + (r.completion_tokens ?? 0), 0)

  return {
    sampleSize: rows.length,
    since: rows.at(-1)?.created_at ?? null,
    until: rows[0]?.created_at ?? null,
    refusalRate: rows.length ? Number((refusedCount / rows.length).toFixed(3)) : null,
    latency: {
      avgMs: mean(total),
      p50Ms: quantile(total, 0.5),
      p95Ms: quantile(total, 0.95),
      firstTokenAvgMs: mean(first),
      retrievalAvgMs: mean(retrieval),
    },
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      avgPromptPerAsk: rows.length ? Math.round(promptTokens / rows.length) : null,
    },
  }
})
