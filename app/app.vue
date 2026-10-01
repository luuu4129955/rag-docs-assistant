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
type Doc = {
  id: string
  filename: string
  char_count: number | null
  chunkCount: number
  embeddedCount: number
}
type Conversation = { id: string, title: string | null, created_at: string }
type HistoryRow = { id: number, role: string, content: string, sources?: Citations | null }

const MAX_TURNS = 20

const messages = ref<Msg[]>([])
const input = ref('')
const loading = ref(false)
const conversationId = ref<string | null>(null)
const conversations = ref<Conversation[]>([])
const docs = ref<Doc[]>([])
const uploading = ref(false)
const embedding = ref(false)
const toast = ref('')

const rightTab = ref<'src' | 'debug' | 'eval'>('src')
const focusMode = ref(false)
const sourceMsgIndex = ref(-1)
const highlight = ref(0)
const chatModel = ref('')
const threshold = ref(0.45)

const activeTitle = computed(() =>
  conversations.value.find(c => c.id === conversationId.value)?.title || '新对话',
)

const activeSources = computed<Source[]>(() => {
  const idx = sourceMsgIndex.value
  if (idx >= 0 && messages.value[idx]?.sources) return messages.value[idx].sources!
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m.role === 'assistant' && m.sources?.length) return m.sources
  }
  return []
})

const activeUsed = computed(() => {
  const idx = sourceMsgIndex.value
  if (idx >= 0 && messages.value[idx]?.sources) return messages.value[idx].usedCount ?? 0
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i]
    if (m.role === 'assistant' && m.sources?.length) return m.usedCount ?? 0
  }
  return 0
})

const activeRefusal = computed(() =>
  Boolean(activeSources.value.length) && activeUsed.value === 0,
)

function flash(text: string) {
  toast.value = text
  setTimeout(() => { if (toast.value === text) toast.value = '' }, 3200)
}

async function loadHealth() {
  try {
    const h = await $fetch<{ chatModel: string, ragThreshold: number }>('/api/health')
    chatModel.value = h.chatModel || ''
    threshold.value = h.ragThreshold || threshold.value
  }
  catch {}
}

async function loadDocs() {
  try {
    docs.value = await $fetch<Doc[]>('/api/documents')
  }
  catch (e) {
    console.error('读取文档列表失败', e)
  }
}

async function loadConversations() {
  try {
    conversations.value = await $fetch<Conversation[]>('/api/conversations')
  }
  catch (e) {
    console.error('读取会话列表失败', e)
  }
}

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
          threshold: c?.threshold ?? threshold.value,
          refusal: Boolean(sources) && usedCount === 0,
        }
      })
    sourceMsgIndex.value = -1
  }
  catch (e) {
    console.error('读取历史失败', e)
    messages.value = []
  }
}

async function createConversation() {
  const c = await $fetch<{ id: string, title: string | null, created_at: string }>(
    '/api/conversations',
    { method: 'POST' },
  )
  conversationId.value = c.id
  localStorage.setItem('conversationId', c.id)
  conversations.value = [c, ...conversations.value.filter(x => x.id !== c.id)]
  messages.value = []
  return c.id
}

async function newChat() {
  try {
    await createConversation()
  }
  catch (e: any) {
    flash(`创建会话失败：${e?.message || '未知错误'}`)
  }
}

async function selectConversation(id: string) {
  if (id === conversationId.value) return
  conversationId.value = id
  localStorage.setItem('conversationId', id)
  await loadHistory(id)
}

async function renameConversation(id: string, title: string) {
  try {
    await $fetch(`/api/conversations/${id}`, { method: 'PATCH', body: { title } })
    const row = conversations.value.find(c => c.id === id)
    if (row) row.title = title
  }
  catch (e) {
    console.error('更新会话标题失败', e)
  }
}

async function saveMessage(role: 'user' | 'assistant', content: string, citations?: Citations) {
  if (!conversationId.value || !content.trim()) return
  try {
    await $fetch('/api/messages', {
      method: 'POST',
      body: { conversationId: conversationId.value, role, content, citations },
    })
  }
  catch (e) {
    console.error('保存消息失败', e)
  }
}

async function send() {
  const question = input.value.trim()
  if (!question || loading.value) return
  input.value = ''
  loading.value = true

  try {
    if (!conversationId.value) await createConversation()
  }
  catch {
    flash('无法创建会话，请检查服务端配置')
    loading.value = false
    return
  }

  const payload = [...messages.value, { role: 'user', content: question } as Msg].slice(-MAX_TURNS)
  messages.value.push({ role: 'user', content: question })
  await saveMessage('user', question)

  // 第一条提问顺便当作会话标题
  const current = conversations.value.find(c => c.id === conversationId.value)
  if (current && (!current.title || current.title === '新对话')) {
    await renameConversation(current.id, question.slice(0, 24))
  }

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
          if (Array.isArray(obj.sources)) {
            last.sources = obj.sources
            last.usedCount = obj.usedCount ?? 0
            last.threshold = obj.threshold ?? threshold.value
            last.refusal = Boolean(obj.retrieved) && (obj.usedCount ?? 0) === 0
            sourceMsgIndex.value = messages.value.length - 1
            rightTab.value = 'src'
            continue
          }
          const delta = obj.choices?.[0]?.delta?.content
          if (delta) last.content += delta
        }
        catch {}
      }
    }
  }
  catch {
    last.content = '请求出错，请检查网络或密钥'
  }
  finally {
    loading.value = false
  }

  await saveMessage('assistant', last.content, last.sources?.length
    ? { sources: last.sources, usedCount: last.usedCount ?? 0, threshold: last.threshold ?? threshold.value }
    : undefined)
}

function gotoCite(msgIndex: number, n: number) {
  sourceMsgIndex.value = msgIndex >= 0 ? msgIndex : sourceMsgIndex.value
  rightTab.value = 'src'
  focusMode.value = false
  highlight.value = n
  nextTick(() => {
    const el = document.getElementById(`src-${n}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setTimeout(() => { if (highlight.value === n) highlight.value = 0 }, 1600)
  })
}

async function uploadFile(file: File) {
  uploading.value = true
  toast.value = ''
  try {
    const form = new FormData()
    form.append('file', file)
    const r = await $fetch<{ id: string, charCount: number, chunkCount: number }>('/api/documents', {
      method: 'POST',
      body: form,
    })
    flash(`解析完成：${r.charCount} 字 / ${r.chunkCount} 块，正在向量化…`)
    await loadDocs()
    await embedAll(r.id)
  }
  catch (e: any) {
    const brief = e?.data?.statusMessage || e?.message || '未知错误'
    flash(`上传失败：${brief}`)
  }
  finally {
    uploading.value = false
  }
}

async function embedAll(documentId?: string) {
  embedding.value = true
  let total = 0
  try {
    for (let i = 0; i < 200; i++) {
      const r = await $fetch<{ embedded: number, remaining: number, done: boolean }>(
        '/api/chunks/embed',
        { method: 'POST', body: { documentId } },
      )
      total += r.embedded
      if (r.done) break
    }
    flash(`向量化完成：本次处理 ${total} 块`)
    await loadDocs()
  }
  catch (e: any) {
    const brief = e?.data?.statusMessage || e?.message || '未知错误'
    flash(`向量化失败：${brief}`)
  }
  finally {
    embedding.value = false
  }
}

onMounted(async () => {
  await Promise.all([loadHealth(), loadDocs(), loadConversations()])
  const saved = localStorage.getItem('conversationId')
  if (saved && conversations.value.some(c => c.id === saved)) {
    conversationId.value = saved
    await loadHistory(saved)
  }
  else if (conversations.value.length) {
    conversationId.value = conversations.value[0].id
    localStorage.setItem('conversationId', conversations.value[0].id)
    await loadHistory(conversations.value[0].id)
  }
  else {
    await newChat()
  }
})
</script>

<template>
  <div class="app">
    <AppSidebar
      :docs="docs"
      :conversations="conversations"
      :active-id="conversationId"
      :uploading="uploading"
      :embedding="embedding"
      :chat-model="chatModel"
      @new-chat="newChat"
      @select-chat="selectConversation"
      @upload="uploadFile"
      @embed="embedAll()"
    />

    <main class="chat">
      <header class="head">
        <span class="title">{{ activeTitle }}</span>
        <span class="tag">{{ chatModel || '未配置模型' }}</span>
        <span class="tag">阈值 {{ threshold.toFixed(2) }}</span>
        <span v-if="toast" class="toast">{{ toast }}</span>
        <button class="btn btn-ghost side-toggle" @click="focusMode = !focusMode">
          <AppIcon name="panel" />
          {{ focusMode ? '显示面板' : '收起面板' }}
        </button>
      </header>

      <div class="thread">
        <div v-if="!messages.length" class="hero">
          <h2>基于你的文档回答，并且给出出处</h2>
          <p class="panel-hint">
            在左栏上传 PDF / Markdown，向量化之后就能提问；材料里没有的内容会直接拒答。
          </p>
          <div class="examples">
            <button class="btn" @click="input = '代码分割主要做了哪几件事？'; send()">
              代码分割主要做了哪几件事？
            </button>
            <button class="btn" @click="input = 'LLM 指标要定义哪些？'; send()">
              LLM 指标要定义哪些？
            </button>
          </div>
        </div>

        <ChatMessage
          v-for="(m, i) in messages"
          :key="i"
          :message="m"
          :index="i"
          :streaming="loading && i === messages.length - 1 && m.role === 'assistant'"
          @cite="n => gotoCite(i, n)"
        />
      </div>

      <div class="composer">
        <div class="input">
          <textarea
            v-model="input"
            rows="1"
            placeholder="输入问题，Enter 发送，Shift+Enter 换行"
            @keydown.enter.exact.prevent="send"
          />
          <button class="btn btn-primary" :disabled="loading" @click="send">
            <AppIcon name="send" />
            {{ loading ? '生成中…' : '发送' }}
          </button>
        </div>
      </div>
    </main>

    <AppRightPanel
      v-show="!focusMode"
      v-model:tab="rightTab"
      :sources="activeSources"
      :used-count="activeUsed"
      :threshold="threshold"
      :refusal="activeRefusal"
      :highlight="highlight"
    />
  </div>
</template>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  overflow: hidden;
}

.chat { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--surface); }

.head {
  display: flex; align-items: center; gap: 8px;
  padding: 11px 16px; border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast { color: var(--ok); font-size: 11px; }
.side-toggle { margin-left: auto; }

.thread {
  flex: 1 1 auto; overflow-y: auto; padding: 18px 16px;
  display: flex; flex-direction: column; gap: 14px;
}

.hero { margin: auto; max-width: 520px; text-align: center; display: flex; flex-direction: column; gap: 8px; }
.hero h2 { margin: 0; font-size: 17px; }
.examples { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 6px; }

.composer { padding: 10px 16px 14px; border-top: 1px solid var(--border); }
.input {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--surface-2);
}
.input textarea {
  flex: 1 1 auto; min-width: 0; border: 0; background: transparent; resize: none;
  outline: none; padding: 4px 0; max-height: 160px; line-height: 1.5;
}

@media (max-width: 1080px) {
  .side-toggle { display: none; }
}
</style>
