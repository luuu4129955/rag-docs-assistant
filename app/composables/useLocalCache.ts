/**
 * 浏览器本地缓存（localStorage）——「stale-while-revalidate」那一套的轻量实现。
 *
 * 解决的是「刷新页面先白屏、再跳一下」的观感问题：
 * 先把上次的列表/配置立刻画出来，同时后台请求最新数据，回来了再替换。
 *
 * 三个刻意的约束：
 *   1) 带 TTL：缓存只在 maxAgeMs 内被当作可用，过期就当作没有（避免显示隔夜数据）；
 *   2) 带命名空间与版本：换结构时改一版，旧缓存自然失效，不用手动清；
 *   3) 全量 try/catch：Safari 无痕模式、配额写满都会让 localStorage 抛异常，
 *      缓存是优化不是依赖，写不进去就静默降级。
 */
const NS = 'docsqa.cache.v1.'

type Entry<T> = { v: T, t: number }

function storage(): Storage | null {
  try {
    if (!import.meta.client) return null
    return window.localStorage
  }
  catch {
    return null
  }
}

export function useLocalCache() {
  function read<T>(key: string, maxAgeMs = Infinity): { value: T, ageMs: number } | null {
    const s = storage()
    if (!s) return null
    try {
      const raw = s.getItem(NS + key)
      if (!raw) return null
      const entry = JSON.parse(raw) as Entry<T>
      if (typeof entry?.t !== 'number') return null
      const ageMs = Date.now() - entry.t
      if (ageMs > maxAgeMs) return null
      return { value: entry.v, ageMs }
    }
    catch {
      return null
    }
  }

  function write<T>(key: string, value: T) {
    const s = storage()
    if (!s) return
    try {
      s.setItem(NS + key, JSON.stringify({ v: value, t: Date.now() }))
    }
    catch {
      // 配额写满：清掉自己的缓存再试一次，不行就算了
      try {
        clearNamespace(s)
        s.setItem(NS + key, JSON.stringify({ v: value, t: Date.now() }))
      }
      catch {}
    }
  }

  function remove(key: string) {
    const s = storage()
    if (!s) return
    try {
      s.removeItem(NS + key)
    }
    catch {}
  }

  function clearNamespace(s: Storage) {
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(NS)) doomed.push(k)
    }
    doomed.forEach(k => s.removeItem(k))
  }

  /**
   * 先吐缓存、再后台刷新。
   * 返回缓存里的值（没有就返回 null），最新的数据回来时通过 onUpdate 回填。
   */
  function swr<T>(
    key: string,
    options: { maxAgeMs?: number, fetcher: () => Promise<T>, onUpdate: (v: T) => void },
  ): T | null {
    const cached = read<T>(key, options.maxAgeMs ?? Infinity)
    void options.fetcher()
      .then((fresh) => {
        write(key, fresh)
        options.onUpdate(fresh)
      })
      .catch(() => {
        // 拉不到就继续用缓存，别把已经画出来的内容擦掉
      })
    return cached?.value ?? null
  }

  return { read, write, remove, swr }
}
