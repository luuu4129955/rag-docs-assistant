/** 改会话标题：第一条提问会拿来当标题 */
export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少会话 id' })

  const body = await readBody(event)
  const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 60) : ''
  if (!title) throw createError({ statusCode: 400, statusMessage: 'title 不能为空' })

  const db = supabaseServer(event)
  const { data, error } = await db
    .from('conversations')
    .update({ title })
    .eq('id', id)
    .select('id, title')
    .single()

  if (error) {
    console.error('[conversations] 更新标题失败', error)
    throw createError({ statusCode: 500, statusMessage: '更新会话标题失败', data: error.message })
  }

  return data
})
