<script setup lang="ts">
type Source = { n: number, filename: string, idx: number, similarity: number, content: string }
type Citations = { sources: Source[], usedCount: number, threshold: number }
type Msg = {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  usedCount?: number
  threshold?: number
  refusal?: boolean
}
type HistoryRow = { id: number, role: string, content: string, sources?: Citations | null }

const input = ref('')
const messages = ref<Msg[]>([])
const loading = ref(false)
const conversationId = ref<string | null>(null)
const MAX_TURNS = 20

onMounted(async () => {
  conversationId.value = localStorage.getItem('conversationId')
  if (conversationId.value) {
    await loadHistory(conversationId.value)
  } else {
    await createConversation()
  }
})

async function loadHistory(id: string) {
  try {
    const rows = await $fetch<HistoryRow[]>(`/api/conversations/${id}`)
    messages.value = rows
      .filter(r => r.role === 'user' || r.role === 'assistant')
      .map((r) => {
        const c = r.sources && typeof r.sources === 'object' ? r.sources : null
        const sources = Array.isArray(c?.sources) && c.sources.length ? c.sources : undefined
        const usedCount = c?.usedCount ?? 0
        return {
          role: r.role as 'user' | 'assistant',
          content: r.content,
          sources,
          usedCount,
          threshold: c?.threshold ?? 0,
          // 有候选但一块都没过阈值 = 当时是拒答
          refusal: Boolean(sources) && usedCount === 0,
        }
      })
  } catch (e) {
    console.error('读取历史失败', e)
    messages.value = []
  }
}

async function createConversation() {
  try {
    const c = await $fetch<{ id: string }>('/api/conversations', { method: 'POST' })
    conversationId.value = c.id
    localStorage.setItem('conversationId', c.id)
  } catch (e) {
    console.error('创建会话失败', e)
  }
}

async function saveMessage(role: 'user' | 'assistant', content: string, citations?: Citations) {
  if (!conversationId.value || !content.trim()) return
  try {
    await $fetch('/api/messages', {
      method: 'POST',
      body: { conversationId: conversationId.value, role, content, citations },
    })
  } catch (e) {
    // 存库失败不应该影响用户看到回答
    console.error('保存消息失败', e)
  }
}

async function send() {
  const q = input.value.trim()
  if (!q || loading.value) return
  input.value = ''
  loading.value = true

  if (!conversationId.value) await createConversation()

  const payload = [...messages.value, { role: 'user', content: q } as Msg].slice(-MAX_TURNS)
  messages.value.push({ role: 'user', content: q })
  await saveMessage('user', q)

  messages.value.push({ role: 'assistant', content: '' })
  const last = messages.value[messages.value.length - 1]

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payload }),
    })
    if (!res.ok || !res.body) {
      last.content = `请求失败：${res.status}`
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 两层缓冲：stream 保字节完整，buf 保「一个 SSE 包」完整
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const obj = JSON.parse(data)
          // 服务端在正文之前先推一条「这批召回了什么」
          if (Array.isArray(obj.sources)) {
            last.sources = obj.sources
            last.usedCount = obj.usedCount ?? 0
            last.threshold = obj.threshold ?? 0
            last.refusal = Boolean(obj.retrieved) && (obj.usedCount ?? 0) === 0
            continue
          }
          const delta = obj.choices?.[0]?.delta?.content
          if (delta) last.content += delta
        } catch {}
      }
    }
  } catch {
    last.content = '请求出错，请检查网络或密钥'
  } finally {
    loading.value = false
  }

  await saveMessage('assistant', last.content, last.sources?.length
    ? { sources: last.sources, usedCount: last.usedCount ?? 0, threshold: last.threshold ?? 0 }
    : undefined)
}

function gotoCite(msgIndex: number, n: number) {
  const el = document.getElementById(`cite-${msgIndex}-${n}`)
  if (!el) return
  // 点 [1] 应该直接把那条原文展开，只滚动+变底色太不显眼，用户会以为没反应
  const details = el.querySelector('details')
  if (details) details.open = true
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('flash')
  setTimeout(() => el.classList.remove('flash'), 1600)
}

function pct(v?: number) {
  return `${Math.round((v ?? 0) * 100)}%`
}

async function reset() {
  messages.value = []
  await createConversation()
}
</script>

<template>
  <div class="wrap">
    <header>
      <h1>Agent Demo</h1>
      <button class="ghost" @click="reset">清空对话</button>
    </header>

    <DocumentPanel />

    <SearchPanel />

    <div class="list">
      <div v-for="(m, i) in messages" :key="i" :class="['msg', m.role]">
        <span class="who">{{ m.role === 'user' ? '我' : 'AI' }}</span>
        <div class="body">
          <MarkdownText
            v-if="m.role === 'assistant'"
            :text="m.content"
            :cite-count="m.sources?.length ?? 0"
            @cite="n => gotoCite(i, n)"
          />
          <span v-else class="text">{{ m.content || '…' }}</span>

          <p v-if="m.refusal" class="badge">未在文档中找到依据</p>

          <div v-if="m.sources?.length" class="cites-block">
            <p class="cites-title">
              {{ m.refusal
                ? `候选分块 ${m.sources.length} 块：全部低于阈值 ${pct(m.threshold)}，所以没有采用`
                : `引用来源（其中 ${m.usedCount ?? 0} 块进了 prompt）· 点回答里的编号可展开对应原文` }}
            </p>
            <ol class="cites">
              <li
                v-for="s in m.sources"
                :id="`cite-${i}-${s.n}`"
                :key="s.n"
                :class="{ unused: s.n > (m.usedCount ?? 0) }"
              >
                <div class="cite-head">
                  <span class="num">[{{ s.n }}]</span>
                  <span>{{ s.filename }} · 第 {{ s.idx }} 块</span>
                  <span class="sim">{{ (s.similarity * 100).toFixed(1) }}%</span>
                </div>
                <details>
                  <summary>看原文</summary>
                  <p>{{ s.content }}</p>
                </details>
              </li>
            </ol>
          </div>
        </div>
      </div>
      <p v-if="!messages.length" class="empty">先传一份文档并向量化，然后问它问题，比如「SSE 是怎么处理的？」</p>
    </div>

    <div class="bar">
      <input v-model="input" @keyup.enter="send" placeholder="输入问题…" />
      <button :disabled="loading" @click="send">{{ loading ? '生成中…' : '发送' }}</button>
    </div>
  </div>
</template>

<style scoped>
.wrap { max-width: 680px; margin: 40px auto; font-family: system-ui; }
header { display: flex; justify-content: space-between; align-items: center; }
.list { margin: 16px 0; display: flex; flex-direction: column; gap: 10px; }
.msg { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 8px; }
.msg .body { flex: 1; min-width: 0; }
.msg .text { flex: 1; min-width: 0; }
.msg.user .text { white-space: pre-wrap; }
.msg.user { background: #eef4ff; }
.msg.assistant { background: #f6f6f6; }
.who { flex: none; font-weight: 600; opacity: .6; }
.empty { color: #999; }
.badge {
  margin: 8px 0 0;
  padding: 3px 8px;
  border-radius: 999px;
  background: #fff3d6;
  color: #b45309;
  font-size: 12px;
  display: inline-block;
}
.cites { margin: 10px 0 0; padding: 0; list-style: none; border-top: 1px dashed #ddd; }
.cites-title { margin: 10px 0 0; font-size: 12px; color: #888; }
.cites li { padding: 8px 0 6px; border-bottom: 1px solid #eee; transition: background .3s; }
.cites li:last-child { border-bottom: none; }
.cites li.unused { opacity: .5; }
.cites li.flash { background: #fff7e0; }
.cite-head { display: flex; gap: 8px; align-items: baseline; font-size: 12px; color: #555; }
.cite-head .num { color: #2563eb; font-weight: 600; }
.cite-head .sim { margin-left: auto; color: #888; }
.cites summary { cursor: pointer; font-size: 12px; color: #2563eb; }
.cites p { margin: 6px 0 0; font-size: 12px; color: #444; line-height: 1.6; white-space: pre-wrap; }
.bar { display: flex; gap: 8px; }
.bar input { flex: 1; padding: 8px; }
button { padding: 8px 14px; cursor: pointer; }
.ghost { background: none; border: 1px solid #ddd; border-radius: 6px; }
</style>
