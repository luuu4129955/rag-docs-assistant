export default defineEventHandler(async (event) => {
  const db = supabaseServer(event)
  const { data, error } = await db
    .from('conversations')
    .insert({ title: '新对话' })
    .select('id, title, created_at')
    .single()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '创建会话失败', data: error.message })
  }
  return data
})