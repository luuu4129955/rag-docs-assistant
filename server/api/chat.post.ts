import type { RetrievedChunk } from '../../utils/retrieve'
import type { ContextBlock } from '../../utils/context'

const MAX_TURNS = 20
const MAX_CHARS = 4000

type MetricPayload = {
  userId?: string
  conversationId?: string
  model?: string
  retrievalMs?: number
  firstTokenMs?: number
  totalMs?: number
  promptTokens?: number
  completionTokens?: number
  retrievedCount?: number
  usedCount?: number
  refused?: boolean
  error?: string
}

/** 指标写库失败不能影响问答本身，所以整段吞掉异常，只留日志 */
async function recordMetric(event: any, payload: MetricPayload) {
  try {
    const db = supabaseServer(event)
    // supabase-js 不抛异常，错误在返回值里，必须自己看
    const { error } = await db.from('chat_metrics').insert({
      user_id: payload.userId ?? null,
      conversation_id: payload.conversationId ?? null,
      model: payload.model ?? null,
      retrieval_ms: payload.retrievalMs ?? null,
      first_token_ms: payload.firstTokenMs ?? null,
      total_ms: payload.totalMs ?? null,
      prompt_tokens: payload.promptTokens ?? null,
      completion_tokens: payload.completionTokens ?? null,
      retrieved_count: payload.retrievedCount ?? null,
      used_count: payload.usedCount ?? null,
      refused: payload.refused ?? false,
      error: payload.error ?? null,
    })
    if (error) {
      logEvent('metrics.write_failed', { message: error.message })
    }
  }
  catch (e: any) {
    logEvent('metrics.write_failed', { message: e?.message || String(e) })
  }
}

function sseEvent(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/**
 * 把一段固定文本包装成和模型一样的 SSE 流。
 * 好处是前端不用为「拒答」写特例——它收到的还是逐字输出的 delta。
 */
function textSseStream(prefix: string, text: string) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(prefix))
      controller.enqueue(encoder.encode(sseEvent({ choices: [{ delta: { content: text } }] })))
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

/**
 * 把召回的分块拼成系统提示。三条规则对应三种失效：
 * 用自己的知识补充 → 幻觉；不标引用 → 无法溯源；材料没有却硬答 → 编造。
 * 材料本身由 buildContext 组装（带邻居上下文 + 预算裁剪），这里只负责措辞。
 */
function buildSystemPrompt(blocks: ContextBlock[]) {
  const context = blocks
    .map(b => `[${b.n}]（来自${b.label}）\n${b.text}`)
    .join('\n\n')

  return `你是文档问答助手，只能依据下面提供的材料回答。

输出格式（必须严格遵守）：
1. 先说结论，再分点说明，用中文，保持简洁。
2. 每一个要点结尾都必须标注依据编号，写成 [1] 或 [1][3]。
   正确示例：主包从 569KB 降到 62KB [1]
   错误示例：主包从 569KB 降到 62KB（没有编号 —— 不允许出现）
3. 只使用材料里的事实，不要用你自己的知识补充或推测。
4. 材料往往只是要点式的笔记，只要里面有相关信息，就基于它归纳作答，
   并说明材料覆盖到哪一步；只有材料完全答不了这个问题时，才回答「材料里没有提到」。

材料：
${context}`
}

export default defineEventHandler(async (event) => {
  const startedAt = Date.now()
  // 先认人：没登录就没有问答，避免匿名请求把额度刷光
  const user = await requireUser(event)
  logEvent('chat.start', { userId: user.id })

  const body = await readBody(event)
  const raw = Array.isArray(body?.messages) ? body.messages : []
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : undefined

  // 前端传来的内容一律不可信：过滤掉非法角色，限制条数和单条长度
  const messages = raw
    .filter((m: any) =>
      m && typeof m.content === 'string'
      && ['system', 'user', 'assistant'].includes(m.role))
    .slice(-MAX_TURNS)
    .map((m: any) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))

  if (!messages.length) {
    throw createError({ statusCode: 400, statusMessage: 'messages 不能为空' })
  }

  const config = useRuntimeConfig(event)
  // 聊天模型只要是 OpenAI 兼容接口就行：默认 DeepSeek，也可以指到别家
  const chatKey = String(config.chatKey || config.deepseekKey || '').trim()
  const chatBase = String(config.chatBase || 'https://api.deepseek.com').replace(/\/+$/, '')
  const chatModel = String(config.chatModel || 'deepseek-chat')

  if (!chatKey) {
    throw createError({
      statusCode: 500,
      statusMessage: '服务端未配置 NUXT_CHAT_KEY（或 NUXT_DEEPSEEK_KEY）',
    })
  }

  // 检索只关心「这一轮问了什么」，用最后一条用户消息当查询
  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
  const topK = Number(config.ragTopK) || 6
  const threshold = Number(config.ragThreshold) || 0.35
  const rerankOn = rerankConfigured(event)
  const rerankThreshold = Number(config.rerankThreshold) || 0

  // 检索失败不该拖垮聊天：拿不到材料就退回普通对话，但原因必须留在日志里
  let candidates: RetrievedChunk[] = []
  let used: RetrievedChunk[] = []
  let retrievalOk = false
  let retrievalMs = 0

  if (lastUser && config.embeddingKey) {
    const t = Date.now()
    try {
      candidates = await retrieveChunks(event, user.id, lastUser.content, topK)
      retrievalOk = true
      // 有重排序分数时按它筛（向量只能看"像不像"，reranker 判断"能不能回答"）；
      // 没标定阈值就退回向量相似度
      used = rerankOn && rerankThreshold > 0
        ? candidates.filter(c => Number(c.rerankScore ?? Number.NEGATIVE_INFINITY) >= rerankThreshold)
        : candidates.filter(c => Number(c.similarity) >= threshold)
    }
    catch (e: any) {
      logEvent('chat.retrieval_failed', { userId: user.id, message: e?.message || String(e) })
    }
    retrievalMs = Date.now() - t
  }
  else if (lastUser && !config.embeddingKey) {
    logEvent('chat.retrieval_skipped', { reason: 'no_embedding_key' })
  }

  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache')

  // 先把召回结果发给前端：引用列表要显示，且必须在正文之前到达
  const sourceEvent = sseEvent({
    sources: candidates.map((c, i) => ({
      n: i + 1,
      filename: c.filename,
      idx: c.idx,
      similarity: Number(c.similarity),
      rerankScore: c.rerankScore ?? null,
      content: c.content,
    })),
    usedCount: used.length,
    retrieved: retrievalOk,
    threshold,
    model: chatModel,
  })

  // 有材料但一块都没过阈值 → 直接拒答，不花模型的钱
  if (retrievalOk && !used.length) {
    logEvent('chat.refused', {
      userId: user.id,
      retrievalMs,
      retrieved: candidates.length,
      topSimilarity: candidates[0]?.similarity ?? null,
    })
    await recordMetric(event, {
      userId: user.id,
      conversationId,
      model: chatModel,
      retrievalMs,
      totalMs: Date.now() - startedAt,
      retrievedCount: candidates.length,
      usedCount: 0,
      refused: true,
    })
    return textSseStream(
      sourceEvent,
      '文档里没有找到和这个问题相关的内容，我无法依据材料回答。可以换个说法，或者先上传相关文档。',
    )
  }

  // 小检索、大上下文：把命中块的前后邻居一起带上，并按预算裁剪
  const contextBlocks = used.length ? await buildContext(event, used) : []
  const finalMessages = contextBlocks.length
    ? [{ role: 'system', content: buildSystemPrompt(contextBlocks) }, ...messages]
    : messages

  const res = await fetch(`${chatBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chatKey}` },
    body: JSON.stringify({
      model: chatModel,
      messages: finalMessages,
      stream: true,
      temperature: 0.3,
      // 让上游在最后一块里带上 token 用量，指标才有的算
      stream_options: { include_usage: true },
    }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text()
    logEvent('chat.upstream_error', { status: res.status, detail: detail.slice(0, 300) })
    await recordMetric(event, {
      userId: user.id,
      conversationId,
      model: chatModel,
      retrievalMs,
      totalMs: Date.now() - startedAt,
      error: `上游 ${res.status}`,
    })
    throw createError({ statusCode: res.status || 500, statusMessage: '模型接口调用失败', data: detail })
  }

  const upstream = res.body
  const decoder = new TextDecoder()
  let sseBuffer = ''
  let answer = ''
  let firstTokenMs: number | null = null
  let usage: { prompt?: number, completion?: number } = {}

  /** 一边转发一边“顺路”统计：首字延迟、token 用量、答案全文 */
  function inspect(chunkText: string) {
    sseBuffer += chunkText
    const parts = sseBuffer.split('\n\n')
    sseBuffer = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const obj = JSON.parse(data)
        const delta = obj.choices?.[0]?.delta?.content
        if (delta) {
          if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt
          answer += delta
        }
        if (obj.usage) {
          usage = { prompt: obj.usage.prompt_tokens, completion: obj.usage.completion_tokens }
        }
      }
      catch {}
    }
  }

  async function finish(error?: string) {
    const totalMs = Date.now() - startedAt
    logEvent('chat.done', {
      userId: user.id,
      retrievalMs,
      firstTokenMs,
      totalMs,
      answerChars: answer.length,
      retrieved: candidates.length,
      used: used.length,
      promptTokens: usage.prompt ?? null,
      completionTokens: usage.completion ?? null,
      error: error ?? null,
    })
    await recordMetric(event, {
      userId: user.id,
      conversationId,
      model: chatModel,
      retrievalMs,
      firstTokenMs: firstTokenMs ?? undefined,
      totalMs,
      promptTokens: usage.prompt,
      completionTokens: usage.completion,
      retrievedCount: candidates.length,
      usedCount: used.length,
      error,
    })
  }

  // 先把召回结果推给前端，再把模型输出原样转发
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(sourceEvent))

      const reader = upstream.getReader()
      ;(async () => {
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) inspect(decoder.decode(value, { stream: true }))
            controller.enqueue(value)
          }
          controller.close()
          await finish()
        }
        catch (err: any) {
          controller.error(err)
          await finish(err?.message || String(err))
        }
      })()
    },
    cancel() {
      // 用户中途关掉页面时，把上游连接也断掉，别继续烧 token
      upstream.cancel().catch(() => {})
    },
  })
})
