// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    // 由环境变量 NUXT_DEEPSEEK_KEY 覆盖
    deepseekKey: '',
    supabaseUrl: '',
    supabaseServiceKey: '',
    // 向量化服务，默认硅基流动的 BGE-M3（1024 维，免费）
    embeddingKey: '',
    embeddingBase: 'https://api.siliconflow.cn/v1',
    embeddingModel: 'BAAI/bge-m3',
    // 聊天模型，默认 DeepSeek；换服务商时三个一起改（key / base / model）
    chatKey: '',
    chatBase: 'https://api.deepseek.com',
    chatModel: 'deepseek-chat',
    // 检索参数：取回几块、低于多少分算「没找到」
    // 阈值没有普适值，用页面上的「检索调试」看真实分数分布后再调
    ragTopK: 6,
    ragThreshold: 0.35,
  },
})
