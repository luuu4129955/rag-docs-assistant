/**
 * 部署自检接口：只报告「配置了没有」，不返回任何密钥内容。
 * 线上排查时直接打开 /api/health 即可。
 */
export default defineEventHandler((event) => {
  const config = useRuntimeConfig(event)

  const host = (value: unknown) => {
    const raw = String(value || '').trim()
    if (!raw) return null
    try {
      return new URL(raw).host
    }
    catch {
      return null
    }
  }

  const supabaseUrl = String(config.supabaseUrl || '').trim()
  const chatKey = String(config.chatKey || config.deepseekKey || '').trim()

  return {
    deepseekKey: Boolean(String(config.deepseekKey || '').trim()),
    supabaseUrl: Boolean(supabaseUrl),
    supabaseServiceKey: Boolean(String(config.supabaseServiceKey || '').trim()),
    supabaseHost: host(supabaseUrl),
    // 聊天模型
    chatKey: Boolean(chatKey),
    chatBaseHost: host(config.chatBase),
    chatModel: String(config.chatModel || ''),
    // 向量化与检索
    embeddingKey: Boolean(String(config.embeddingKey || '').trim()),
    embeddingModel: String(config.embeddingModel || ''),
    ragTopK: Number(config.ragTopK) || 6,
    ragThreshold: Number(config.ragThreshold) || 0.35,
  }
})
