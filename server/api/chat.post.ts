import type { RetrievedChunk } from '../../utils/retrieve'

const MAX_TURNS = 20
const MAX_CHARS = 4000
// 单块进 prompt 的字数上限：块太长会挤占上下文，也更容易把噪声带进去
const MAX_CONTEXT_CHARS = 900

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
 */
function buildSystemPrompt(chunks: RetrievedChunk[]) {
  const context = chunks
    .map((c, i) => `[${i + 1}]（来自《${c.filename}》第 ${c.idx} 块）\n${c.content.slice(0, MAX_CONTEXT_CHARS)}`)
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
  const body = await readBody(event)
  const raw = Array.isArray(body?.messages) ? body.messages : []

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

  // 检索失败不该拖垮聊天：拿不到材料就退回普通对话，但原因必须留在日志里
  let candidates: RetrievedChunk[] = []
  let used: RetrievedChunk[] = []
  let retrievalOk = false

  if (lastUser && config.embeddingKey) {
    try {
      candidates = await retrieveChunks(event, lastUser.content, topK)
      retrievalOk = true
      used = candidates.filter(c => Number(c.similarity) >= threshold)
    }
    catch (e: any) {
      console.error('[chat] 检索失败，本轮按普通对话处理', e?.message || e)
    }
  }
  else if (lastUser && !config.embeddingKey) {
    console.warn('[chat] 未配置 NUXT_EMBEDDING_KEY，跳过检索（回答不会带引用）')
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
      content: c.content,
    })),
    usedCount: used.length,
    retrieved: retrievalOk,
    threshold,
    model: chatModel,
  })

  // 有材料但一块都没过阈值 → 直接拒答，不花模型的钱
  if (retrievalOk && !used.length) {
    return textSseStream(
      sourceEvent,
      '文档里没有找到和这个问题相关的内容，我无法依据材料回答。可以换个说法，或者先上传相关文档。',
    )
  }

  const finalMessages = used.length
    ? [{ role: 'system', content: buildSystemPrompt(used) }, ...messages]
    : messages

  const res = await fetch(`${chatBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${chatKey}` },
    body: JSON.stringify({ model: chatModel, messages: finalMessages, stream: true, temperature: 0.3 }),
  })

  if (!res.ok || !res.body) {
    const detail = await res.text()
    console.error('[chat] 上游报错', res.status, detail)
    throw createError({ statusCode: res.status || 500, statusMessage: '模型接口调用失败', data: detail })
  }

  const upstream = res.body

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
            controller.enqueue(value)
          }
          controller.close()
        }
        catch (err) {
          controller.error(err)
        }
      })()
    },
    cancel() {
      // 用户中途关掉页面时，把上游连接也断掉，别继续烧 token
      upstream.cancel().catch(() => {})
    },
  })
})
