export default defineEventHandler(async (event) => {
  const db = supabaseServer(event)

  const { data: docs, error } = await db
    .from('documents')
    .select('id, filename, char_count, created_at')
    .order('created_at', { ascending: false })

  if (error) {
    console.error('[documents] 读取列表失败', error)
    throw createError({ statusCode: 500, statusMessage: '读取文档列表失败', data: error.message })
  }

  // 分块数在内存里统计：文档量小时够用，量大了应该换成数据库聚合查询
  const { data: chunkRows } = await db.from('chunks').select('document_id')
  const counts = new Map<string, number>()
  for (const row of chunkRows ?? []) {
    counts.set(row.document_id, (counts.get(row.document_id) ?? 0) + 1)
  }

  // 只取"已有向量"的行，不拉向量内容（不然要传几十万个浮点数）
  const { data: embeddedRows } = await db
    .from('chunks')
    .select('document_id')
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
