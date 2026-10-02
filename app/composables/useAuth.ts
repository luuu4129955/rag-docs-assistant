/**
 * 前端登录态：tokens 存在 localStorage，所有 API 请求带上 Authorization。
 *
 * 为什么不用 supabase-js 管理会话？因为那需要在浏览器里放 publishable key。
 * 这里改成「登录走我们自己的服务端代理」，前端只拿我们的 token，
 * 浏览器里不出现任何 Supabase 密钥。
 */
type Session = { accessToken: string, refreshToken: string, expiresAt: number }
type User = { id: string, email?: string }

const STORAGE_KEY = 'docsqa.session'

export function useAuth() {
  const user = useState<User | null>('auth.user', () => null)
  const session = useState<Session | null>('auth.session', () => null)
  const ready = useState('auth.ready', () => false)

  function persist(next: Session | null) {
    session.value = next
    if (!import.meta.client) return
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    else localStorage.removeItem(STORAGE_KEY)
  }

  async function login(email: string, password: string) {
    const res = await $fetch<{ user: User, session: Session }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
    persist(res.session)
    user.value = res.user
    return res
  }

  async function register(email: string, password: string) {
    const res = await $fetch<{ user: User | null, session: Session | null, needsConfirm: boolean }>(
      '/api/auth/register',
      { method: 'POST', body: { email, password } },
    )
    if (res.session) {
      persist(res.session)
      user.value = res.user
    }
    return res
  }

  async function refresh() {
    const token = session.value?.refreshToken
    if (!token) return false
    try {
      const res = await $fetch<{ session: Session }>('/api/auth/refresh', {
        method: 'POST',
        body: { refreshToken: token },
      })
      persist(res.session)
      return true
    }
    catch {
      persist(null)
      user.value = null
      return false
    }
  }

  async function logout() {
    const token = session.value?.accessToken
    if (token) {
      await $fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    persist(null)
    user.value = null
  }

  /** 刷新页面后恢复登录态：先验 token，过期就用 refresh token 换新的 */
  async function restore() {
    if (!import.meta.client) return
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try {
        session.value = JSON.parse(raw) as Session
      }
      catch {
        persist(null)
      }
    }

    if (session.value) {
      try {
        user.value = await $fetch<User>('/api/auth/me', {
          headers: { Authorization: `Bearer ${session.value.accessToken}` },
        })
      }
      catch {
        const ok = await refresh()
        if (ok) {
          user.value = await $fetch<User>('/api/auth/me', {
            headers: { Authorization: `Bearer ${session.value!.accessToken}` },
          }).catch(() => null)
        }
      }
    }

    ready.value = true
  }

  return { user, session, ready, login, register, logout, refresh, restore }
}
