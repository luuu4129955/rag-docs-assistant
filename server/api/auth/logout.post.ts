/** 退出：让 Supabase 注销这个 access token（这里不做本地黑名单） */
export default defineEventHandler(async (event) => {
  const token = bearerToken(event)
  if (token) {
    const db = supabaseServer(event)
    await db.auth.admin.signOut(token).catch(() => {})
  }
  return { ok: true }
})
