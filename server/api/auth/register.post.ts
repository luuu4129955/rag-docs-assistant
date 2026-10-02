/**
 * 注册。用服务端代理由 Supabase Auth 处理，避免把密钥放到前端。
 * 如果项目开了「Confirm email」，注册不会直接返回 session，前端要提示去邮箱确认。
 */
export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  const email = String(body?.email ?? '').trim().toLowerCase()
  const password = String(body?.password ?? '')

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw createError({ statusCode: 400, statusMessage: '请填写有效邮箱' })
  }
  if (password.length < 6) {
    throw createError({ statusCode: 400, statusMessage: '密码至少 6 位' })
  }

  const db = supabaseServer(event)
  const { data, error } = await db.auth.signUp({ email, password })

  if (error) {
    console.error('[auth] 注册失败', error.message)
    throw createError({ statusCode: 400, statusMessage: error.message })
  }

  return {
    user: data.user ? { id: data.user.id, email: data.user.email } : null,
    session: data.session
      ? {
          accessToken: data.session.access_token,
          refreshToken: data.session.refresh_token,
          expiresAt: data.session.expires_at,
        }
      : null,
    // 没有 session 说明还需要邮箱确认
    needsConfirm: !data.session,
  }
})
