// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  // 关掉 Nuxt DevTools：右下角那个浮标在演示时很碍事，需要时再临时开
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],

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
    // 重排序：向量先粗召回 rerankTopN 条，再用 reranker 精排到 ragTopK 条
    // rerankThreshold 是原始分（不是 0~1 概率），要用 eval/calibrate-rerank.mjs 看分布后再定
    rerankBase: '',
    rerankModel: 'BAAI/bge-reranker-v2-m3',
    rerankTopN: 20,
    rerankThreshold: 0.1,
    // 混合检索：向量 + 关键词两路，用 RRF 融合（要靠 sql/04-hybrid.sql 建的关键词函数）
    hybridEnabled: true,
    // 定时任务密钥：Vercel Cron 会带着它来调用 /api/jobs/tick（也兼容 CRON_SECRET）
    jobsSecret: '',
  },
})
