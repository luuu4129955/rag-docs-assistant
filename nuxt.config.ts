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
    // 缓存：embedding 缓存按「文本哈希」复用；答案缓存按「问题 + 语料版本 + 参数」复用
    embeddingCache: true,
    answerCache: true,
    cacheTtlDays: 7,
    // 成本估算：每百万 token 的价格（元）。默认 0 = 不显示成本（用的是免费模型）
    // 换成 DeepSeek 时可以填 2 / 8 之类，面板就会显示估算成本
    priceInPerM: 0,
    priceOutPerM: 0,
    // 限流：令牌桶，按「用户 + 动作」计数。本地调试嫌烦可以设 NUXT_RATE_LIMIT_ENABLED=false
    rateLimitEnabled: true,
    rateLimitChatPerMin: 30,
    rateLimitChatBurst: 20,
    // 后台任务：失败自动重试几次、退避基准秒数（30 → 60 → 120），超过就进死信
    jobsMaxAttempts: 3,
    jobsRetryBaseSec: 30,
    // 告警 webhook（飞书/钉钉/Slack 机器人）。不配就只打结构化日志
    alertWebhook: '',
    // 分片上传合并后的单文件上限（MB）。分片把请求体撑开后，这里才是真正的天花板
    maxUploadMb: 40,
    // 定时任务密钥：Vercel Cron 会带着它来调用 /api/jobs/tick（也兼容 CRON_SECRET）
    jobsSecret: '',

    // B 档迁移开关：设了就把它当作 Python 后端地址（例如 http://127.0.0.1:8000）。
    // 留空 = 完全走原来的 TS 实现。见 server/middleware/py-backend.ts。
    pyBackendUrl: '',
    // 只转发这些路径前缀（逗号分隔）。留空 = 全部转发。
    pyBackendPaths: '',
  },
})
