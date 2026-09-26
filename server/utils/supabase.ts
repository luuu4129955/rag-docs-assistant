import { createClient } from '@supabase/supabase-js'

export function supabaseServer(event: any) {
  const { supabaseUrl, supabaseServiceKey } = useRuntimeConfig(event)
  if (!supabaseUrl || !supabaseServiceKey) {
    throw createError({ statusCode: 500, statusMessage: '服务端未配置 Supabase 环境变量' })
  }
  return createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } })
}