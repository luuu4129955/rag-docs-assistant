<script setup lang="ts">
type Result = {
  id: number
  document_id: string
  filename: string
  idx: number
  content: string
  similarity: number
}

const query = ref('')
const k = ref(5)
const loading = ref(false)
const results = ref<Result[]>([])
const hint = ref('')

async function search() {
  const q = query.value.trim()
  if (!q || loading.value) return

  loading.value = true
  hint.value = ''

  try {
    const r = await $fetch<{ results: Result[] }>('/api/search', {
      method: 'POST',
      body: { query: q, k: k.value },
    })
    results.value = r.results
    if (!r.results.length) hint.value = '没有召回到任何分块——检查文档是否已经向量化。'
  }
  catch (err: any) {
    hint.value = `检索失败：${err?.data?.statusMessage || err?.message || '未知错误'}`
    results.value = []
  }
  finally {
    loading.value = false
  }
}

function percent(v: number) {
  return `${(v * 100).toFixed(1)}%`
}
</script>

<template>
  <details class="panel">
    <summary>检索调试</summary>

    <div class="body">
      <p class="desc">
        输入一个问题，看它召回了哪些分块、相似度多少。<strong>RAG 出问题时，先看这里。</strong>
      </p>

      <div class="bar">
        <input v-model="query" placeholder="例如：SSE 是怎么处理的？" @keyup.enter="search">
        <select v-model.number="k">
          <option :value="3">Top 3</option>
          <option :value="5">Top 5</option>
          <option :value="10">Top 10</option>
        </select>
        <button :disabled="loading" @click="search">
          {{ loading ? '检索中…' : '检索' }}
        </button>
      </div>

      <p v-if="hint" class="tip">{{ hint }}</p>

      <ul v-if="results.length" class="results">
        <li v-for="r in results" :key="r.id">
          <div class="head">
            <span class="score">{{ percent(r.similarity) }}</span>
            <span class="src">{{ r.filename }} · 第 {{ r.idx }} 块</span>
          </div>
          <div class="bar-bg"><div class="bar-fill" :style="{ width: percent(Math.max(r.similarity, 0)) }" /></div>
          <p class="content">{{ r.content.slice(0, 180) }}{{ r.content.length > 180 ? '…' : '' }}</p>
        </li>
      </ul>
    </div>
  </details>
</template>

<style scoped>
.panel {
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  padding: 10px 14px;
  margin-bottom: 16px;
}
summary { cursor: pointer; font-weight: 600; }
.body { margin-top: 12px; }
.desc { color: #777; font-size: 13px; margin: 0 0 10px; }
.bar { display: flex; gap: 8px; }
.bar input { flex: 1; padding: 8px; }
.bar select, .bar button { padding: 8px 12px; }
.tip { color: #b45309; font-size: 13px; margin: 10px 0 0; }
.results { list-style: none; padding: 0; margin: 14px 0 0; }
.results li { padding: 10px 0; border-bottom: 1px solid #f0f0f0; }
.results li:last-child { border-bottom: none; }
.head { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
.score { color: #2563eb; font-weight: 600; }
.src { color: #888; }
.bar-bg { height: 4px; background: #eee; border-radius: 2px; overflow: hidden; }
.bar-fill { height: 100%; background: #2563eb; }
.content { font-size: 13px; color: #444; margin: 8px 0 0; line-height: 1.6; }
</style>
