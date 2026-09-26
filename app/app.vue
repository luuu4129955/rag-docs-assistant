<script setup lang="ts">
type Msg = { role: 'user' | 'assistant'; content: string }
type HistoryRow = { id: number; role: string; content: string }

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
      .map(r => ({ role: r.role as Msg['role'], content: r.content }))
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

async function saveMessage(role: 'user' | 'assistant', content: string) {
  if (!conversationId.value || !content.trim()) return
  try {
    await $fetch('/api/messages', {
      method: 'POST',
      body: { conversationId: conversationId.value, role, content },
    })
  } catch (e) {
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
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') continue
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content
          if (delta) last.content += delta
        } catch {}
      }
    }
  } catch {
    last.content = '请求出错，请检查网络或密钥'
  } finally {
    loading.value = false
  }

  await saveMessage('assistant', last.content)
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

    <div class="list">
      <div v-for="(m, i) in messages" :key="i" :class="['msg', m.role]">
        <span class="who">{{ m.role === 'user' ? '我' : 'AI' }}</span>
        <MarkdownText v-if="m.role === 'assistant'" :text="m.content" />
        <span v-else class="text">{{ m.content || '…' }}</span>
      </div>
      <p v-if="!messages.length" class="empty">问点什么，比如「解释一下 ref 和 reactive 的区别」</p>
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
.msg .text { flex: 1; min-width: 0; }
.msg.user .text { white-space: pre-wrap; }
.msg.user { background: #eef4ff; }
.msg.assistant { background: #f6f6f6; }
.who { flex: none; font-weight: 600; opacity: .6; }
.empty { color: #999; }
.bar { display: flex; gap: 8px; }
.bar input { flex: 1; padding: 8px; }
button { padding: 8px 14px; cursor: pointer; }
.ghost { background: none; border: 1px solid #ddd; border-radius: 6px; }
</style>
