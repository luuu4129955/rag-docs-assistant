import { createClient } from '@supabase/supabase-js'

function configOf(event: any) {
  const config = useRuntimeConfig(event)
  // 从 Vercel 面板粘贴的值经常带首尾空白，这里统一清掉
  const supabaseUrl = String(config.supabaseUrl || '').trim()
  const supabaseServiceKey = String(config.supabaseServiceKey || '').trim()

  if (!supabaseUrl || !supabaseServiceKey) {
    console.error('[supabase] 环境变量缺失', {
      hasUrl: Boolean(supabaseUrl),
      hasKey: Boolean(supabaseServiceKey),
    })
    throw createError({ statusCode: 500, statusMessage: '服务端未配置 Supabase 环境变量' })
  }

  try {
    new URL(supabaseUrl)
  } catch {
    console.error('[supabase] NUXT_SUPABASE_URL 不是合法地址:', JSON.stringify(supabaseUrl))
    throw createError({ statusCode: 500, statusMessage: 'NUXT_SUPABASE_URL 格式不正确' })
  }

  return { supabaseUrl, supabaseServiceKey }
}

/**
 * 管理端客户端：用 service key，绕过 RLS。
 * 只用在两件事上——校验登录态、读写存储桶；业务数据一律走 supabaseAsUser。
 */
export function supabaseServer(event: any) {
  const { supabaseUrl, supabaseServiceKey } = configOf(event)
  return createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
}

/**
 * 用户端客户端：请求头里带上用户的 access token。
 * PostgREST 会按这个 token 决定角色，RLS 策略随之生效——
 * 也就是说「只能看到自己的数据」是数据库在把关，不是靠应用层记得加 where。
 */
export function supabaseAsUser(event: any) {
  const { supabaseUrl, supabaseServiceKey } = configOf(event)
  const token = bearerToken(event)
  if (!token) {
    throw createError({ statusCode: 401, statusMessage: '未登录' })
  }
  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

export function bearerToken(event: any) {
  const header = String(getHeader(event, 'authorization') || '')
  return header.startsWith('Bearer ') ? header.slice(7).trim() : ''
}
