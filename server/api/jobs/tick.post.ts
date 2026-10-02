/**
 * 后台任务：把「解析 + 分块 + 向量化」拆成一轮一轮的小步执行。
 *
 * 谁能调用：
 *   1) 定时任务（带上 NUXT_JOBS_SECRET / Vercel 的 CRON_SECRET）→ 处理所有用户的待办
 *   2) 已登录用户 → 只处理自己的文档（页面上的「继续处理」按钮走这条路）
 *
 * 一次只做一小批，是为了不撞 Vercel 函数默认 10 秒的超时上限；
 * 前端负责轮询，直到没有 pending / embedding 的文档为止。
 */
const PARSE_PER_TICK = 1
const EMBED_PER_TICK = 16

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  const secret = String(config.jobsSecret || process.env.CRON_SECRET || '').trim()
  const header = String(getHeader(event, 'authorization') || '')
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''

  // 定时任务没有用户身份，用密钥换「处理全部用户」的权限
  const isCron = Boolean(secret) && Boolean(token) && token === secret
  const owner = isCron ? null : (await requireUser(event)).id

  const db = owner ? supabaseAsUser(event) : supabaseServer(event)
  const storage = supabaseServer(event)
  const now = () => new Date().toISOString()
  let parsed = 0
  let embedded = 0

  // ---------- 第一段：解析 + 分块 ----------
  let parseQuery = db
    .from('documents')
    .select('id, storage_path, filename')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(PARSE_PER_TICK)
  if (owner) parseQuery = parseQuery.eq('user_id', owner)

  const { data: pendingDocs, error: pendingError } = await parseQuery
  if (pendingError) {
    console.error('[jobs] 读取待解析文档失败', pendingError)
    throw createError({ statusCode: 500, statusMessage: '读取待解析文档失败', data: pendingError.message })
  }

  for (const doc of pendingDocs ?? []) {
    try {
      const ext = (String(doc.storage_path).split('.').pop() || '').toLowerCase()
      const { data: blob, error: dlError } = await storage.storage.from('docs').download(doc.storage_path)
      if (dlError || !blob) throw new Error(dlError?.message || '文件下载失败')

      const text = sanitizeText(await extractTextFromFile(new Uint8Array(await blob.arrayBuffer()), ext))
      const chunks = chunkText(text)
      if (!chunks.length) throw new Error('没有解析出文字内容（扫描版 PDF 需要先做 OCR）')

      // 重跑时先清掉旧分块，保证这一步是幂等的
      await db.from('chunks').delete().eq('document_id', doc.id)
      const { error: insertError } = await db.from('chunks').insert(
        chunks.map((content, idx) => ({
          document_id: doc.id,
          idx,
          content,
          char_count: content.length,
        })),
      )
      if (insertError) throw new Error(insertError.message)

      await db.from('documents')
        .update({ status: 'embedding', char_count: text.length, error: null, updated_at: now() })
        .eq('id', doc.id)
      parsed++
    }
    catch (e: any) {
      console.error('[jobs] 解析失败', doc.filename, e?.message || e)
      await db.from('documents')
        .update({ status: 'failed', error: String(e?.message || e).slice(0, 300), updated_at: now() })
        .eq('id', doc.id)
    }
  }

  // ---------- 第二段：向量化 ----------
  let embedQuery = db
    .from('documents')
    .select('id')
    .eq('status', 'embedding')
    .order('created_at', { ascending: true })
    .limit(5)
  if (owner) embedQuery = embedQuery.eq('user_id', owner)

  const { data: embeddingDocs } = await embedQuery

  for (const doc of embeddingDocs ?? []) {
    const { data: rows } = await db
      .from('chunks')
      .select('id, content')
      .eq('document_id', doc.id)
      .is('embedding', null)
      .order('id', { ascending: true })
      .limit(EMBED_PER_TICK)

    if (!rows?.length) {
      await db.from('documents').update({ status: 'ready', updated_at: now() }).eq('id', doc.id)
      continue
    }

    try {
      const vectors = await embedTexts(event, rows.map(r => r.content))
      await Promise.all(rows.map((row, i) =>
        db.from('chunks').update({ embedding: JSON.stringify(vectors[i]) }).eq('id', row.id),
      ))
      embedded += rows.length
    }
    catch (e: any) {
      console.error('[jobs] 向量化失败', doc.id, e?.message || e)
      await db.from('documents')
        .update({ status: 'failed', error: String(e?.message || e).slice(0, 300), updated_at: now() })
        .eq('id', doc.id)
      continue
    }

    const { count } = await db
      .from('chunks')
      .select('id', { count: 'exact', head: true })
      .eq('document_id', doc.id)
      .is('embedding', null)
    if (!count) {
      await db.from('documents').update({ status: 'ready', updated_at: now() }).eq('id', doc.id)
    }
  }

  // ---------- 还剩多少没处理完 ----------
  let restQuery = db
    .from('documents')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'embedding'])
  if (owner) restQuery = restQuery.eq('user_id', owner)
  const { count: remaining } = await restQuery

  return {
    parsed,
    embedded,
    remaining: remaining ?? 0,
    done: (remaining ?? 0) === 0,
    scope: owner ? 'self' : 'all',
  }
})
