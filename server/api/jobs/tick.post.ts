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

  // 非定时任务才限流：Cron 带的是密钥，不该被按用户限流误伤
  if (owner) await enforceRateLimit(event, owner, 'jobs')

  const db = owner ? supabaseAsUser(event) : supabaseServer(event)
  const storage = supabaseServer(event)
  const now = () => new Date().toISOString()
  let parsed = 0
  let embedded = 0
  let requeued = 0

  const maxAttempts = Number(config.jobsMaxAttempts) || 3
  const retryBaseSec = Number(config.jobsRetryBaseSec) || 30

  /**
   * 失败处理：没到上限就退避重试（failed + next_retry_at），到了上限就进死信并告警。
   * 退避用指数（30s → 60s → 120s）——上游偶发抖动时，第二次、第三次往往就过了，
   * 但连续失败三次基本可以判定不是抖动。
   */
  async function markFailure(
    doc: { id: string, filename?: string, attempts?: number | null },
    stage: string,
    err: unknown,
  ) {
    const attempts = (doc.attempts ?? 0) + 1
    const message = String((err as any)?.message || err).slice(0, 300)
    if (attempts >= maxAttempts) {
      const { error } = await db.from('documents').update({
        status: 'dead',
        attempts,
        error: message,
        dead_lettered_at: now(),
        next_retry_at: null,
        updated_at: now(),
      }).eq('id', doc.id)
      // 没跑 sql/06 时这几列不存在：退回「只记失败」，别把状态卡在原地反复重试
      if (error && /attempts|next_retry_at|dead_lettered_at/.test(error.message ?? '')) {
        await db.from('documents').update({ status: 'failed', error: message, updated_at: now() }).eq('id', doc.id)
        logEvent('jobs.retry_unavailable', { documentId: doc.id, hint: '数据库还没执行 sql/06-limits-jobs.sql' })
        return
      }
      logEvent('jobs.dead_letter', { documentId: doc.id, filename: doc.filename, stage, attempts, error: message })
      alert('文档处理进入死信', { documentId: doc.id, filename: doc.filename, stage, attempts, error: message })
    }
    else {
      const backoffSec = retryBaseSec * 2 ** (attempts - 1)
      const { error } = await db.from('documents').update({
        status: 'failed',
        attempts,
        error: message,
        next_retry_at: new Date(Date.now() + backoffSec * 1000).toISOString(),
        updated_at: now(),
      }).eq('id', doc.id)
      if (error && /attempts|next_retry_at|dead_lettered_at/.test(error.message ?? '')) {
        await db.from('documents').update({ status: 'failed', error: message, updated_at: now() }).eq('id', doc.id)
        logEvent('jobs.retry_unavailable', { documentId: doc.id, hint: '数据库还没执行 sql/06-limits-jobs.sql' })
        return
      }
      logEvent('jobs.retry_scheduled', { documentId: doc.id, stage, attempts, backoffSec })
    }
  }

  // ---------- 第 0 段：把退避到点的失败任务重新排进队列 ----------
  // 之所以重置回 pending 而不是记个中间态：解析这一步本身是幂等的
  // （会先删旧分块再重写），从头跑一遍最省心，也不会留下半截数据。
  try {
    let retryQuery = db
      .from('documents')
      .select('id')
      .eq('status', 'failed')
      .is('dead_lettered_at', null)
      .lt('attempts', maxAttempts)
      .or(`next_retry_at.is.null,next_retry_at.lte.${now()}`)
      .limit(3)
    if (owner) retryQuery = retryQuery.eq('user_id', owner)
    const { data: retryDocs, error } = await retryQuery
    if (error) throw new Error(error.message)
    for (const doc of retryDocs ?? []) {
      const { error: upError } = await db.from('documents')
        .update({ status: 'pending', next_retry_at: null, updated_at: now() })
        .eq('id', doc.id)
      if (!upError) requeued++
    }
  }
  catch (e: any) {
    // 没跑 sql/06 时这一整段跳过，主流程照常
    logEvent('jobs.retry_scan_skipped', { message: e?.message || String(e) })
  }

  // ---------- 第一段：解析 + 分块 ----------
  let parseQuery = db
    .from('documents')
    // select('*') 而不是点名道姓：没跑 sql/06 时 attempts 不存在也不会整段报错
    .select('*')
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
      await markFailure(doc, 'parse', e)
    }
  }

  // ---------- 第二段：向量化 ----------
  let embedQuery = db
    .from('documents')
    .select('*')
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
      await markFailure(doc, 'embed', e)
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
  const { count: running } = await restQuery

  // 等待重试的失败任务也算「没处理完」——否则前端会在它们到点重试之前就停止轮询
  let retrying = 0
  try {
    let failedQuery = db
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'failed')
      .is('dead_lettered_at', null)
    if (owner) failedQuery = failedQuery.eq('user_id', owner)
    const { count, error } = await failedQuery
    if (!error) retrying = count ?? 0
  }
  catch {}

  const remaining = (running ?? 0) + retrying

  return {
    parsed,
    embedded,
    requeued,
    retrying,
    remaining,
    done: remaining === 0,
    scope: owner ? 'self' : 'all',
  }
})
