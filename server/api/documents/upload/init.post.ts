/**
 * 分片上传 · 第一步：开一个上传会话（或认领一个没传完的）。
 *
 * 为什么需要这一步：大文件没法一次塞进 Serverless 的请求体（约 4.5MB 上限），
 * 得切成小片分别传、最后在服务端合并。分片还要能「断点续传」——
 * 所以每次开传前先问一句：这个文件（按文件名+大小+修改时间认指纹）之前传到哪了？
 * 有未完成的会话就把已收到的分片列表还给前端，只补没传的那几片。
 */
const CHUNK_SIZE = 1024 * 1024 // 1MB：够小，单请求不会撞上限；够大，40MB 也才 40 个请求

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await enforceRateLimit(event, user.id, 'uploadInit')

  const body = await readBody(event)
  const filename = String(body?.filename ?? '').trim()
  const size = Number(body?.size) || 0
  const fingerprint = String(body?.fingerprint ?? '').trim() || `${filename}:${size}`

  if (!filename) throw createError({ statusCode: 400, statusMessage: '缺少文件名' })
  if (size <= 0) throw createError({ statusCode: 400, statusMessage: '文件为空' })

  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (ext !== 'pdf' && !TEXT_EXTENSIONS.includes(ext)) {
    throw createError({ statusCode: 400, statusMessage: `暂不支持 .${ext} 格式，请上传 PDF / Markdown / TXT` })
  }

  const config = useRuntimeConfig(event)
  const maxBytes = (Number(config.maxUploadMb) || 40) * 1024 * 1024
  if (size > maxBytes) {
    throw createError({
      statusCode: 413,
      statusMessage: `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`,
    })
  }

  const totalParts = Math.max(1, Math.ceil(size / CHUNK_SIZE))
  const db = supabaseAsUser(event)

  // 认领未完成的上传：同一用户 + 同一指纹 + 还开着
  const { data: existing } = await db
    .from('upload_sessions')
    .select('id, chunk_size, total_parts')
    .eq('user_id', user.id)
    .eq('fingerprint', fingerprint)
    .eq('status', 'open')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let uploadId = existing?.id as string | undefined
  let chunkSize = Number(existing?.chunk_size) || CHUNK_SIZE
  let parts = Number(existing?.total_parts) || totalParts

  if (!uploadId) {
    const { data: created, error } = await db
      .from('upload_sessions')
      .insert({
        user_id: user.id,
        filename,
        size_bytes: size,
        fingerprint,
        chunk_size: CHUNK_SIZE,
        total_parts: totalParts,
      })
      .select('id')
      .single()
    if (error || !created) {
      const hint = /upload_sessions/.test(error?.message ?? '') ? '（数据库还没执行 sql/06-limits-jobs.sql）' : ''
      throw createError({ statusCode: 500, statusMessage: `创建上传会话失败${hint}`, data: error?.message })
    }
    uploadId = created.id
    chunkSize = CHUNK_SIZE
    parts = totalParts
  }

  // 存储里实际已经收到哪些分片（以存储为准，不信前端记的进度）
  const storage = supabaseServer(event)
  const { data: objs } = await storage.storage.from('docs').list(`${user.id}/uploads/${uploadId}`, { limit: 1000 })
  const received = (objs ?? [])
    .map(o => Number(/^part-(\d+)$/.exec(o.name)?.[1]))
    .filter(n => Number.isInteger(n))
    .sort((a, b) => a - b)

  return { uploadId, chunkSize, totalParts: parts, received, resumed: Boolean(existing) }
})
