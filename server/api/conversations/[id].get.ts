export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少会话 id' })

  const user = await requireUser(event)
  const db = supabaseAsUser(event)

  // 先确认这个会话是本人的，再读消息；否则拿着别人的 id 就能读历史
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (convError) {
    throw createError({ statusCode: 500, statusMessage: '读取会话失败', data: convError.message })
  }
  if (!conv) {
    throw createError({ statusCode: 404, statusMessage: '会话不存在' })
  }

  const { data, error } = await db
    .from('messages')
    .select('id, role, content, sources')
    .eq('conversation_id', id)
    .order('id', { ascending: true })

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '读取历史失败', data: error.message })
  }
  return data ?? []
})
