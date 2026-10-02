// 一次请求只处理一小批：Vercel 函数默认 10 秒超时，切小批能让前端循环调用、
// 中途失败也能续跑（未处理的分块 embedding 仍是 null，下次接着算）
const BATCH_SIZE = 16

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const documentId = typeof body?.documentId === 'string' && body.documentId ? body.documentId : null
  const user = await requireUser(event)
  const db = supabaseAsUser(event)

  // 只处理自己的文档：分块表本身没有 user_id，靠文档归属划范围
  const { data: ownedDocs } = await db.from('documents').select('id').eq('user_id', user.id)
  const ownedIds = (ownedDocs ?? []).map(d => d.id)
  if (documentId && !ownedIds.includes(documentId)) {
    throw createError({ statusCode: 404, statusMessage: '文档不存在' })
  }
  const scope = documentId ? [documentId] : ownedIds
  if (!scope.length) {
    return { embedded: 0, remaining: 0, done: true }
  }

  const buildQuery = () => {
    return db
      .from('chunks')
      .select('id, content')
      .is('embedding', null)
      .in('document_id', scope)
      .order('id', { ascending: true })
      .limit(BATCH_SIZE)
  }

  const countRemaining = async () => {
    const { count } = await db
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null)
      .in('document_id', scope)
    return count ?? 0
  }

  const { data: pending, error } = await buildQuery()
  if (error) {
    console.error('[embed] 读取待处理分块失败', error)
    throw createError({ statusCode: 500, statusMessage: '读取待处理分块失败', data: error.message })
  }

  if (!pending?.length) {
    return { embedded: 0, remaining: 0, done: true }
  }

  const vectors = await embedTexts(event, pending.map(c => c.content))

  // pgvector 接收 "[0.1,0.2,...]" 这种字符串形式的向量
  const results = await Promise.all(
    pending.map((chunk, i) =>
      db.from('chunks').update({ embedding: JSON.stringify(vectors[i]) }).eq('id', chunk.id),
    ),
  )
  const failed = results.find(r => r.error)
  if (failed?.error) {
    console.error('[embed] 写回向量失败', failed.error)
    throw createError({ statusCode: 500, statusMessage: '写回向量失败', data: failed.error.message })
  }

  const remaining = await countRemaining()
  return { embedded: pending.length, remaining, done: remaining === 0 }
})
