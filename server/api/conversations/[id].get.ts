export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少会话 id' })

  const db = supabaseServer(event)
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
