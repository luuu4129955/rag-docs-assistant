import { createClient } from '@supabase/supabase-js'

export function supabaseServer(event: any) {
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

  return createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
}
