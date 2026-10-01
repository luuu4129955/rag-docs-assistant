/**
 * 会话列表：左栏用，按时间倒序。
 * 空会话（建了还没提问的）不显示——否则点几次「新对话」就攒一堆「新对话」。
 */
export default defineEventHandler(async (event) => {
  const db = supabaseServer(event)
  const { data, error } = await db
    .from('conversations')
    .select('id, title, created_at, messages(count)')
    .order('created_at', { ascending: false })
    .limit(50)

  if (error) {
    console.error('[conversations] 读取列表失败', error)
    throw createError({ statusCode: 500, statusMessage: '读取会话列表失败', data: error.message })
  }

  return (data ?? [])
    .filter((row: any) => (row.messages?.[0]?.count ?? 0) > 0)
    .map((row: any) => ({ id: row.id, title: row.title, created_at: row.created_at }))
})
