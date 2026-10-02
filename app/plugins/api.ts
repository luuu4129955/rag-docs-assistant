/**
 * $api：所有业务请求的统一出口。
 * 1) 自动带上 Authorization 头——每个调用点不用再自己拼 token；
 * 2) 遇到 401 自动用 refresh token 换一次，再重试原请求（只重试一次）。
 */
export default defineNuxtPlugin(() => {
  const auth = useAuth()

  const raw = $fetch.create({
    onRequest({ options }) {
      const token = auth.session.value?.accessToken
      if (!token) return
      const headers = new Headers(options.headers as HeadersInit)
      headers.set('Authorization', `Bearer ${token}`)
      options.headers = headers
    },
  })

  async function api(path: string, options: Record<string, any> = {}) {
    try {
      return await raw(path, options)
    }
    catch (e: any) {
      const status = e?.response?.status ?? e?.statusCode
      if (status !== 401) throw e
      const ok = await auth.refresh()
      if (!ok) throw e
      return await raw(path, options)
    }
  }

  return { provide: { api } }
})
