/**
 * 分片上传 · 第二步：传单个分片。
 *
 * 分片直接落在 Storage 的 {user}/uploads/{uploadId}/part-N。
 * 用 upsert 覆盖而不是拒绝重复：断点续传时前端可能重传某一片，
 * 让它覆盖比报错再重试省事，也不会产生孤儿分片。
 */
export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  await enforceRateLimit(event, user.id, 'uploadPart')

  const uploadId = getRouterParam(event, 'uploadId')
  if (!uploadId) throw createError({ statusCode: 400, statusMessage: '缺少 uploadId' })

  const form = await readMultipartFormData(event)
  const rawIndex = form?.find(p => p.name === 'index')?.data?.toString('utf-8')
  const part = form?.find(p => p.name === 'part' && p.filename)
  const index = Number(rawIndex)

  if (!part) throw createError({ statusCode: 400, statusMessage: '没有收到分片数据' })
  if (!Number.isInteger(index) || index < 0) throw createError({ statusCode: 400, statusMessage: '分片序号不合法' })

  const db = supabaseAsUser(event)
  // 会话必须是本人的、且还开着；否则拿到别人的 uploadId 就能往里写
  const { data: session } = await db
    .from('upload_sessions')
    .select('id, total_parts')
    .eq('id', uploadId)
    .eq('user_id', user.id)
    .eq('status', 'open')
    .maybeSingle()
  if (!session) throw createError({ statusCode: 404, statusMessage: '上传会话不存在或已结束' })
  if (index >= Number(session.total_parts)) {
    throw createError({ statusCode: 400, statusMessage: '分片序号超出范围' })
  }

  const storage = supabaseServer(event)
  const { error } = await storage.storage
    .from('docs')
    .upload(`${user.id}/uploads/${uploadId}/part-${index}`, part.data, {
      contentType: 'application/octet-stream',
      upsert: true,
    })
  if (error) {
    throw createError({ statusCode: 500, statusMessage: '分片写入失败', data: error.message })
  }

  await db.from('upload_sessions').update({ updated_at: new Date().toISOString() }).eq('id', uploadId)
  return { ok: true, received: index }
})
