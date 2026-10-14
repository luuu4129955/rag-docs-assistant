/**
 * 分片上传 · 第三步：合并分片，正式建文档。
 *
 * 合并发生在服务端：把 Storage 里的分片按序读出来拼成一个 Buffer 再写回去。
 * 为什么不做成「前端直接传整文件 + 预签名 URL」：那需要前端掌握存储凭据，
 * 跟本项目「浏览器里不放任何密钥」的原则冲突。这里用服务端合并，
 * 代价是单文件受函数内存限制（配置里默认 40MB），换来的是权限边界干净。
 *
 * 合并成功后把会话标 done、清掉临时分片——临时文件不留着占空间。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await enforceRateLimit(event, user.id, 'uploadComplete')

  const uploadId = getRouterParam(event, 'uploadId')
  if (!uploadId) throw createError({ statusCode: 400, statusMessage: '缺少 uploadId' })

  const db = supabaseAsUser(event)
  const { data: session } = await db
    .from('upload_sessions')
    .select('id, filename, size_bytes, total_parts, status')
    .eq('id', uploadId)
    .eq('user_id', user.id)
    .maybeSingle()
  if (!session) throw createError({ statusCode: 404, statusMessage: '上传会话不存在' })
  if (session.status !== 'open') throw createError({ statusCode: 409, statusMessage: '这个上传已经结束了' })

  const storage = supabaseServer(event)
  const prefix = `${user.id}/uploads/${uploadId}`
  const { data: objs } = await storage.storage.from('docs').list(prefix, { limit: 1000 })
  const parts = (objs ?? [])
    .map(o => ({ name: o.name, index: Number(/^part-(\d+)$/.exec(o.name)?.[1]) }))
    .filter(p => Number.isInteger(p.index))
    .sort((a, b) => a.index - b.index)

  if (parts.length !== Number(session.total_parts)) {
    throw createError({
      statusCode: 400,
      statusMessage: `分片不完整：应有 ${session.total_parts} 片，实际 ${parts.length} 片`,
    })
  }

  // 顺序读出、拼接
  const buffers: Buffer[] = []
  for (const p of parts) {
    const { data: blob, error } = await storage.storage.from('docs').download(`${prefix}/${p.name}`)
    if (error || !blob) {
      throw createError({ statusCode: 500, statusMessage: `读取分片 ${p.name} 失败`, data: error?.message })
    }
    buffers.push(Buffer.from(await blob.arrayBuffer()))
  }
  const merged = Buffer.concat(buffers)

  const config = useRuntimeConfig(event)
  const maxBytes = (Number(config.maxUploadMb) || 40) * 1024 * 1024
  if (merged.length > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: `合并后 ${(merged.length / 1024 / 1024).toFixed(1)}MB，超过上限` })
  }

  const ext = (String(session.filename).split('.').pop() || '').toLowerCase()
  const storagePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
  const { error: upError } = await storage.storage.from('docs').upload(storagePath, merged, {
    contentType: ext === 'pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
    upsert: false,
  })
  if (upError) {
    throw createError({ statusCode: 500, statusMessage: '合并文件写入存储失败', data: upError.message })
  }

  const { data: doc, error: docError } = await db
    .from('documents')
    .insert({
      user_id: user.id,
      filename: session.filename,
      storage_path: storagePath,
      size_bytes: merged.length,
      status: 'pending',
    })
    .select('id, filename, status, created_at')
    .single()

  if (docError || !doc) {
    // 补偿：数据库没写成就把刚上传的合并文件删掉，别留孤儿
    await storage.storage.from('docs').remove([storagePath])
    const hint = /user_id|status/.test(docError?.message ?? '') ? '（数据库还没执行 sql/01-auth-rls.sql 或 sql/02-jobs.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `写入文档记录失败${hint}`, data: docError?.message })
  }

  // 收尾：会话标结束、临时分片清掉
  await db.from('upload_sessions')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', uploadId)
  await storage.storage.from('docs').remove(parts.map(p => `${prefix}/${p.name}`))

  return { id: doc.id, filename: doc.filename, status: doc.status, queued: true, sizeBytes: merged.length }
})
