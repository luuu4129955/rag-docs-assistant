// Vercel 函数对请求体有硬限制（约 4.5MB），这里留出余量
const MAX_BYTES = 4 * 1024 * 1024

/**
 * 上传 = 只做两件便宜的事：把文件存进桶、往数据库写一条 pending 记录。
 *
 * 解析、分块、向量化都不在这里做了——它们耗时长、还可能失败，
 * 放在请求里会让用户干等、超时后还留下半截数据。
 * 现在由后台任务（/api/jobs/tick）接手，状态写在 documents.status 里。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)

  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.filename)

  if (!file) {
    throw createError({ statusCode: 400, statusMessage: '没有收到文件' })
  }
  if (file.data.length > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `文件超过 ${MAX_BYTES / 1024 / 1024}MB 限制（Vercel 函数请求体上限）`,
    })
  }

  const filename = file.filename as string
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext !== 'pdf' && !TEXT_EXTENSIONS.includes(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: `暂不支持 .${ext} 格式，请上传 PDF / Markdown / TXT`,
    })
  }

  const db = supabaseAsUser(event)
  // 私有桶没有面向普通用户的策略，存储走管理端客户端
  const storage = supabaseServer(event)

  // 存储键 = 用户目录 + 随机名：原始文件名可能有中文、空格、重名，真名存在数据库里
  const storagePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
  const { error: uploadError } = await storage.storage
    .from('docs')
    .upload(storagePath, file.data, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    console.error('[documents] 上传存储失败', uploadError)
    throw createError({ statusCode: 500, statusMessage: '文件上传到存储失败', data: uploadError.message })
  }

  const { data: doc, error: docError } = await db
    .from('documents')
    .insert({
      user_id: user.id,
      filename,
      storage_path: storagePath,
      size_bytes: file.data.length,
      status: 'pending',
    })
    .select('id, filename, status, created_at')
    .single()

  if (docError || !doc) {
    console.error('[documents] 写入文档记录失败', docError)
    // 补偿：数据库回滚了，存储不会跟着回滚，得手动补上
    await storage.storage.from('docs').remove([storagePath])
    const hint = /user_id|status/.test(docError?.message ?? '') ? '（数据库还没执行 sql/01-auth-rls.sql 或 sql/02-jobs.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `写入文档记录失败${hint}`, data: docError?.message })
  }

  return {
    id: doc.id,
    filename: doc.filename,
    status: doc.status,
    // 前端拿这个决定要不要开始轮询进度
    queued: true,
  }
})
