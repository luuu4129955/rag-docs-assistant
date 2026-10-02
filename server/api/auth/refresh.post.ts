/** access token 默认 1 小时过期，前端拿 refresh token 换新的 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const refreshToken = String(body?.refreshToken ?? '')
  if (!refreshToken) {
    throw createError({ statusCode: 400, statusMessage: '缺少 refreshToken' })
  }

  const db = supabaseServer(event)
  const { data, error } = await db.auth.refreshSession({ refresh_token: refreshToken })

  if (error || !data.session) {
    throw createError({ statusCode: 401, statusMessage: '登录已过期，请重新登录' })
  }

  return {
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
    },
  }
})
