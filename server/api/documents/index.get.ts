export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = supabaseAsUser(event)

  const baseSelect = 'id, filename, char_count, status, error, created_at'
  let { data: docs, error } = await db
    .from('documents')
    .select(`${baseSelect}, attempts, next_retry_at, dead_lettered_at`)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  // 没跑 sql/06 时退回旧字段，页面上少显示重试信息，但列表还能用
  if (error && /attempts|next_retry_at|dead_lettered_at/.test(error.message ?? '')) {
    ;({ data: docs, error } = await db
      .from('documents')
      .select(baseSelect)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }))
  }

  if (error) {
    console.error('[documents] 读取列表失败', error)
    const hint = /user_id|status/.test(error.message ?? '') ? '（数据库还没执行 sql/01-auth-rls.sql 或 sql/02-jobs.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `读取文档列表失败${hint}`, data: error.message })
  }

  const ids = (docs ?? []).map(d => d.id)
  if (!ids.length) return []

  // 分块数在内存里统计：文档量小时够用，量大了应该换成数据库聚合查询
  const { data: chunkRows } = await db.from('chunks').select('document_id').in('document_id', ids)
  const counts = new Map<string, number>()
  for (const row of chunkRows ?? []) {
    counts.set(row.document_id, (counts.get(row.document_id) ?? 0) + 1)
  }

  // 只取"已有向量"的行，不拉向量内容（不然要传几十万个浮点数）
  const { data: embeddedRows } = await db
    .from('chunks')
    .select('document_id')
    .in('document_id', ids)
    .not('embedding', 'is', null)
  const embeddedCounts = new Map<string, number>()
  for (const row of embeddedRows ?? []) {
    embeddedCounts.set(row.document_id, (embeddedCounts.get(row.document_id) ?? 0) + 1)
  }

  return (docs ?? []).map(doc => ({
    ...doc,
    chunkCount: counts.get(doc.id) ?? 0,
    embeddedCount: embeddedCounts.get(doc.id) ?? 0,
  }))
})
