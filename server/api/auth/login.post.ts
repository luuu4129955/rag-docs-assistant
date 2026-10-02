export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (!email || !password) {
    throw createError({ statusCode: 400, statusMessage: '请填写邮箱和密码' })
  }

  const db = supabaseServer(event)
  const { data, error } = await db.auth.signInWithPassword({ email, password })

  if (error || !data.session) {
    // 不区分「邮箱不存在」和「密码错误」，避免被人拿来枚举账号
    throw createError({ statusCode: 401, statusMessage: '邮箱或密码不正确' })
  }

  return {
    user: { id: data.user.id, email: data.user.email },
    session: {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresAt: data.session.expires_at,
    },
  }
})
