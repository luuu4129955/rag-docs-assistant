// 一次请求只处理一小批：Vercel 函数默认 10 秒超时，切小批能让前端循环调用、
// 中途失败也能续跑（未处理的分块 embedding 仍是 null，下次接着算）
const BATCH_SIZE = 16

export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => ({}))
  const documentId = typeof body?.documentId === 'string' && body.documentId ? body.documentId : null
  const db = supabaseServer(event)

  const buildQuery = () => {
    let q = db
      .from('chunks')
      .select('id, content')
      .is('embedding', null)
      .order('id', { ascending: true })
      .limit(BATCH_SIZE)
    if (documentId) q = q.eq('document_id', documentId)
    return q
  }

  const countRemaining = async () => {
    let q = db.from('chunks').select('id', { count: 'exact', head: true }).is('embedding', null)
    if (documentId) q = q.eq('document_id', documentId)
    const { count } = await q
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
