/**
 * 登录态校验。
 *
 * 关键点：token 是前端传上来的，前端传来的东西一律不可信——
 * 不能自己解析 JWT 就算数，必须让 Supabase 验一次签名和有效期。
 * 验完拿到 user.id，后面所有查询都围着这个 id 转。
 */
export type AuthUser = { id: string, email?: string }

export async function requireUser(event: any): Promise<AuthUser> {
  const token = bearerToken(event)
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: '未登录' })
  }

  const db = supabaseServer(event)
  const { data, error } = await db.auth.getUser(token)

  if (error || !data?.user) {
    throw createError({ statusCode: 401, statusMessage: '登录已过期，请重新登录' })
  }

  return { id: data.user.id, email: data.user.email ?? undefined }
}
