/**
 * 部署自检接口：只报告「配置了没有」，不返回任何密钥内容。
 * 线上排查时直接打开 /api/health 即可。
 */
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)
  const url = String(config.supabaseUrl || '').trim()

  let supabaseHost: string | null = null
  try {
    supabaseHost = new URL(url).host
  } catch {
    supabaseHost = null
  }

  return {
    deepseekKey: Boolean(String(config.deepseekKey || '').trim()),
    supabaseUrl: Boolean(url),
    supabaseServiceKey: Boolean(String(config.supabaseServiceKey || '').trim()),
    supabaseHost,
  }
})
