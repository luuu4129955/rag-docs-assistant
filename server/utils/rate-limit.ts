/**
 * 令牌桶限流。
 *
 * 为什么放数据库而不是进程内存：Serverless 每次请求可能落在不同实例上，
 * 内存计数器各算各的，等于没限。放进 Postgres，所有实例共享同一个桶。
 * 取令牌的动作封装成数据库函数 take_token，「读-改-写」在一条语句里加锁完成，
 * 并发请求不会各读到旧值再各扣一次（那会让限流悄悄漏掉）。
 *
 * 容错：拿不到数据库（迁移没跑、网络抖动）时一律放行——
 * 限流是保护措施，不该反而把功能整个卡死。
 */

export type RateAction =
  | 'chat'
  | 'search'
  | 'uploadInit'
  | 'uploadPart'
  | 'uploadComplete'
  | 'write'
  | 'telemetry'
  | 'jobs'

type Preset = { perMin: number, burst: number, cost?: number }

/**
 * 各动作的默认额度。原则：越贵、越容易被刷的动作，桶越小。
 * 分片上传那条要放大——40MB 的文件按 1MB 切片就是 40 个请求。
 */
const PRESETS: Record<RateAction, Preset> = {
  chat: { perMin: 30, burst: 20 },
  search: { perMin: 60, burst: 30 },
  uploadInit: { perMin: 12, burst: 6 },
  uploadPart: { perMin: 600, burst: 120 },
  uploadComplete: { perMin: 12, burst: 6 },
  write: { perMin: 60, burst: 20 },
  telemetry: { perMin: 120, burst: 40 },
  // 前端轮询会密集调用，给足额度
  jobs: { perMin: 600, burst: 240 },
}

export type RateLimitResult = { allowed: boolean, remaining: number, retryAfterMs: number }

/** 取一个令牌。key 建议用 `<action>:<userId>` 或 `<action>:<ip>`。 */
export async function takeRateLimit(
  event: any,
  key: string,
  preset: Preset,
): Promise<RateLimitResult> {
  try {
    const db = supabaseServer(event)
    const { data, error } = await db.rpc('take_token', {
      p_key: key,
      p_capacity: preset.burst,
      p_refill_per_sec: preset.perMin / 60,
      p_cost: preset.cost ?? 1,
    })
    if (error) throw new Error(error.message)
    const row = Array.isArray(data) ? data[0] : data
    return {
      allowed: row?.allowed !== false,
      remaining: Number(row?.remaining ?? preset.burst),
      retryAfterMs: Number(row?.retry_after_ms ?? 0),
    }
  }
  catch (e: any) {
    logEvent('rate_limit.unavailable', { key, message: e?.message || String(e) })
    return { allowed: true, remaining: preset.burst, retryAfterMs: 0 }
  }
}

/**
 * 在接口里「就地」限流：超限直接抛 429，并把剩余额度挂到响应头上。
 * 之所以让它抛异常而不是返回布尔值，是为了不给调用方「忘了判断」的机会。
 */
export async function enforceRateLimit(event: any, userId: string, action: RateAction) {
  const config = useRuntimeConfig(event)
  if (String(config.rateLimitEnabled ?? true) === 'false') return

  const preset: Preset = action === 'chat'
    ? {
        perMin: Number(config.rateLimitChatPerMin) || PRESETS.chat.perMin,
        burst: Number(config.rateLimitChatBurst) || PRESETS.chat.burst,
      }
    : PRESETS[action]

  const result = await takeRateLimit(event, `${action}:${userId}`, preset)
  setHeader(event, 'X-RateLimit-Remaining', String(Math.max(0, Math.floor(result.remaining))))

  if (!result.allowed) {
    const waitSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000))
    logEvent('rate_limit.blocked', { userId, action, retryAfterMs: result.retryAfterMs })
    setHeader(event, 'Retry-After', String(waitSec))
    throw createError({
      statusCode: 429,
      statusMessage: `操作太频繁，请 ${waitSec} 秒后再试`,
      data: { action, retryAfterMs: result.retryAfterMs },
    })
  }
}
