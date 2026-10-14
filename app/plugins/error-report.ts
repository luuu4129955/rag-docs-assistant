/**
 * 前端错误监控（轻量版 Sentry）。
 *
 * 采集四类：
 *   - js       全局同步报错（window.onerror）
 *   - promise  未处理的 Promise 拒绝
 *   - vue      Vue 组件渲染/生命周期里抛出的异常
 *   - request  $fetch 请求失败（含 5xx 和网络错误）
 *
 * 两个必须做的处理：
 *   1) 聚合去重：一个在渲染循环里反复抛的错，一秒钟能产生几百条，
 *      直接上报会把表写爆。按「类型 + 消息」聚合成一条，带 count 一起报。
 *   2) 批量 + 定时：攒 3 秒一起发，减少请求数；页面隐藏时立刻 flush，
 *      免得关页面那一下的报错丢了。
 *
 * 上报走自己的 /api/telemetry，不需要在浏览器里放任何第三方 key。
 */
type Draft = { kind: string, message: string, source?: string, stack?: string, url?: string, count: number }

export default defineNuxtPlugin((nuxtApp) => {
  if (!import.meta.client) return

  const auth = useAuth()
  const pool = new Map<string, Draft>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const FLUSH_MS = 3000
  const MAX_KEYS = 50

  function push(kind: string, message: string, extra: Partial<Draft> = {}) {
    const msg = String(message || '').slice(0, 500)
    if (!msg) return
    // 别把监控接口自己产生的错误再上报一遍，会死循环
    if ((extra.url || '').includes('/api/telemetry')) return

    const key = `${kind}:${msg}`
    const draft = pool.get(key)
    if (draft) {
      draft.count++
      return
    }
    if (pool.size >= MAX_KEYS) pool.delete(pool.keys().next().value as string)
    pool.set(key, { kind, message: msg, count: 1, ...extra })
    schedule()
  }

  function schedule() {
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, FLUSH_MS)
  }

  async function flush() {
    if (!pool.size) return
    const events = [...pool.values()].map(d => ({
      kind: d.kind,
      message: d.message,
      source: d.source,
      stack: d.stack,
      url: d.url,
      meta: { count: d.count, page: location.pathname },
    }))
    pool.clear()
    try {
      await $fetch('/api/telemetry', {
        method: 'POST',
        body: { events },
        headers: auth.session.value?.accessToken
          ? { Authorization: `Bearer ${auth.session.value.accessToken}` }
          : {},
      })
    }
    catch {
      // 上报失败就算了——监控自己不能变成新的故障源
    }
  }

  window.addEventListener('error', (e) => {
    if (e instanceof ErrorEvent) {
      push('js', e.message, { source: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack })
    }
    else if (e.target && e.target !== window) {
      const t = e.target as HTMLElement
      const src = (t as HTMLImageElement).src || (t as HTMLScriptElement).src || t.tagName
      push('resource', `资源加载失败：${String(src).slice(0, 200)}`, { source: t.tagName })
    }
  }, true)

  window.addEventListener('unhandledrejection', (e) => {
    const reason = (e as PromiseRejectionEvent).reason
    push('promise', reason?.message || String(reason), { stack: reason?.stack })
  })

  nuxtApp.vueApp.config.errorHandler = (err: any, _instance, info) => {
    push('vue', err?.message || String(err), { source: info, stack: err?.stack })
    console.error(err)
  }

  // 页面切到后台/关闭时把攒着的报错立刻发出去
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flush()
  })
})
