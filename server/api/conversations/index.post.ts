export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const db = supabaseAsUser(event)
  const { data, error } = await db
    .from('conversations')
    .insert({ title: '新对话', user_id: user.id })
    .select('id, title, created_at')
    .single()

  if (error) {
    console.error('[conversations] 创建会话失败', error)
    // 迁移没跑时给一句人话，别让人对着 42703 猜
    const hint = /user_id/.test(error.message ?? '') ? '（数据库还没执行 sql/01-auth-rls.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `创建会话失败${hint}`, data: error.message })
  }
  return data
})
