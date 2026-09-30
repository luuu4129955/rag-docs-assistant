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
  },
})
