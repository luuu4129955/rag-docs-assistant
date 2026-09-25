<script setup lang="ts">
const input = ref('')
const answer = ref('')
const loading = ref(false)

async function send() {
  if (!input.value.trim() || loading.value) return
  loading.value = true
  answer.value = ''
  const msg = input.value
  input.value = ''
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: msg }] }),
    })
    if (!res.ok || !res.body) {
      answer.value = `请求失败：${res.status}`
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
          if (delta) answer.value += delta
        } catch {}
      }
    }
  } catch {
    answer.value = '请求出错，请检查网络或密钥'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div style="max-width: 640px; margin: 40px auto; font-family: system-ui">
    <h1>Agent Demo</h1>
    <div style="display: flex; gap: 8px">
      <input v-model="input" @keyup.enter="send" placeholder="问点什么…" style="flex: 1; padding: 8px" />
      <button :disabled="loading" @click="send">{{ loading ? '生成中…' : '发送' }}</button>
    </div>
    <pre style="white-space: pre-wrap; background: #f6f6f6; padding: 12px; border-radius: 8px; min-height: 80px">{{ answer }}</pre>
  </div>
</template>