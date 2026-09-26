export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : ''
  const role = body?.role
  const content = typeof body?.content === 'string' ? body.content : ''

  if (!conversationId) throw createError({ statusCode: 400, statusMessage: 'conversationId 必填' })
  if (!['system', 'user', 'assistant'].includes(role)) {
    throw createError({ statusCode: 400, statusMessage: 'role 不合法' })
  }
  if (!content.trim()) throw createError({ statusCode: 400, statusMessage: 'content 不能为空' })

  const db = supabaseServer(event)
  const { data, error } = await db
    .from('messages')
    .insert({ conversation_id: conversationId, role, content })
    .select()
    .single()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '保存消息失败', data: error.message })
  }
  return data
})