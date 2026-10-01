<script setup lang="ts">
type Source = { n: number, filename: string, idx: number, similarity: number, content: string }
type Hit = { id: number, filename: string, idx: number, content: string, similarity: number }
type EvalSummary = {
  ranAt: string
  model?: string
  answered: string
  cited: string
  refused: string
  refusedByServer: number
  passed: string
  avgMs: number
  maxMs: number
}

const props = defineProps<{
  tab: 'src' | 'debug' | 'eval'
  sources: Source[]
  usedCount: number
  threshold: number
  refusal?: boolean
  highlight?: number
}>()

const emit = defineEmits<{ (e: 'update:tab', tab: 'src' | 'debug' | 'eval'): void }>()

const tabs = [
  { key: 'src' as const, label: '来源' },
  { key: 'debug' as const, label: '检索调试' },
  { key: 'eval' as const, label: '评测' },
]

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

// ---- 检索调试 ----
const q = ref('')
const k = ref(5)
const searching = ref(false)
const hits = ref<Hit[]>([])
const searchHint = ref('')
const liveThreshold = ref(props.threshold)

async function search() {
  const text = q.value.trim()
  if (!text || searching.value) return
  searching.value = true
  searchHint.value = ''
  try {
    const r = await $fetch<{ results: Hit[], threshold: number }>('/api/search', {
      method: 'POST',
      body: { query: text, k: k.value },
    })
    hits.value = r.results
    liveThreshold.value = r.threshold ?? props.threshold
    if (!r.results.length) searchHint.value = '没有召回到任何分块——确认文档已经向量化。'
  }
  catch (e: any) {
    searchHint.value = `检索失败：${e?.data?.statusMessage || e?.message || '未知错误'}`
    hits.value = []
  }
  finally {
    searching.value = false
  }
}

// ---- 评测 ----
const evalData = ref<EvalSummary | null>(null)
const evalMissing = ref(false)

onMounted(async () => {
  try {
    evalData.value = await $fetch<EvalSummary>('/api/eval/latest')
  }
  catch {
    evalMissing.value = true
  }
})
</script>

<template>
  <aside class="panel">
    <div class="tabs">
      <button
        v-for="t in tabs"
        :key="t.key"
        class="tab"
        :class="{ on: props.tab === t.key }"
        @click="emit('update:tab', t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <!-- 来源 -->
    <div v-if="props.tab === 'src'" class="body">
      <p v-if="!props.sources.length" class="panel-hint">还没有回答，来源会显示在这里。</p>
      <template v-else>
        <p class="panel-hint">
          {{ props.refusal
            ? `候选 ${props.sources.length} 块都低于阈值 ${Math.round(props.threshold * 100)}%，所以没有采用`
            : `其中 ${props.usedCount} 块进了 prompt · 点回答里的编号可定位` }}
        </p>
        <div
          v-for="s in props.sources"
          :id="`src-${s.n}`"
          :key="s.n"
          class="src"
          :class="{ dim: s.n > props.usedCount, flash: props.highlight === s.n }"
        >
          <div class="src-top">
            <span class="src-n">[{{ s.n }}]</span>
            <span class="src-f">{{ s.filename }} · 第 {{ s.idx }} 块</span>
            <span class="src-s num">{{ pct(s.similarity) }}</span>
          </div>
          <p class="src-c">{{ s.content }}</p>
        </div>
      </template>
    </div>

    <!-- 检索调试 -->
    <div v-else-if="props.tab === 'debug'" class="body">
      <div class="search-bar">
        <input v-model="q" placeholder="比如：代码分割怎么做的？" @keyup.enter="search">
        <select v-model.number="k">
          <option :value="3">Top 3</option>
          <option :value="5">Top 5</option>
          <option :value="10">Top 10</option>
        </select>
        <button class="btn" :disabled="searching" @click="search">{{ searching ? '…' : '检索' }}</button>
      </div>
      <p class="panel-hint">
        Top-K 原始结果，<b>不过滤阈值</b>——低于 {{ Math.round(liveThreshold * 100) }}% 的只是候选。
      </p>
      <p v-if="searchHint" class="hint-warn">{{ searchHint }}</p>
      <div v-for="h in hits" :key="h.id" class="hit">
        <div class="hit-top">
          <span class="num" :class="{ good: h.similarity >= liveThreshold }">{{ pct(h.similarity) }}</span>
          <span v-if="h.similarity < liveThreshold" class="tag">低于阈值</span>
          <span class="hit-f">{{ h.filename }} · 第 {{ h.idx }} 块</span>
        </div>
        <p class="hit-c">{{ h.content.slice(0, 140) }}{{ h.content.length > 140 ? '…' : '' }}</p>
      </div>
    </div>

    <!-- 评测 -->
    <div v-else class="body">
      <template v-if="evalData">
        <p class="panel-hint">最近一次本地跑分 · {{ evalData.ranAt }}</p>
        <div class="metrics">
          <div class="metric"><span class="mk">答出率</span><span class="mv num">{{ evalData.answered }}</span></div>
          <div class="metric"><span class="mk">引用率</span><span class="mv num">{{ evalData.cited }}</span></div>
          <div class="metric"><span class="mk">拒答率</span><span class="mv num">{{ evalData.refused }}</span></div>
          <div class="metric"><span class="mk">平均延迟</span><span class="mv num">{{ (evalData.avgMs / 1000).toFixed(1) }}s</span></div>
        </div>
        <p class="panel-hint">
          应拒答题里只有 {{ evalData.refusedByServer }} 题是阈值拦下，其余靠模型自觉；
          最慢一次 {{ (evalData.maxMs / 1000).toFixed(1) }}s。
        </p>
      </template>
      <p v-else class="panel-hint">
        {{ evalMissing ? '还没有跑分记录。在项目目录执行：' : '读取中…' }}
      </p>
      <pre v-if="evalMissing" class="cmd">node eval/run.mjs</pre>

      <div class="todo">
        <p class="todo-h">预留的优化位</p>
        <p>· 重排序 Rerank（位置已留）</p>
        <p>· 可答性判断（生成前拦截）</p>
        <p>· 混合检索 / 关键词权重</p>
        <p>· 模型与 Top-K 在线切换</p>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  width: 292px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--side);
  border-left: 1px solid var(--border);
}
.tabs { display: flex; gap: 3px; padding: 10px 10px 8px; border-bottom: 1px solid var(--border); }
.tab {
  border: 0; background: transparent; color: var(--muted);
  padding: 4px 10px; border-radius: var(--radius-sm);
}
.tab:hover { background: var(--surface-2); }
.tab.on { background: var(--surface); color: var(--text); border: 1px solid var(--border); }

.body { flex: 1 1 auto; overflow-y: auto; padding: 10px; }

.src {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 8px 10px; margin-bottom: 8px;
}
.src.dim { opacity: .55; }
.src.flash { border-color: var(--accent); background: var(--accent-soft); }
.src-top { display: flex; align-items: baseline; gap: 6px; margin-bottom: 4px; }
.src-n { color: var(--accent); font-weight: 600; }
.src-f { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.src-s { margin-left: auto; color: var(--muted); font-size: 11px; }
.src-c { color: var(--muted); font-size: 11px; line-height: 1.55; max-height: 96px; overflow: hidden; }

.search-bar { display: flex; gap: 6px; margin-bottom: 8px; }
.search-bar input {
  flex: 1 1 auto; min-width: 0; padding: 6px 9px;
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
}
.search-bar select {
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); padding: 0 4px;
}
.hint-warn { margin: 6px 0; color: var(--warn); font-size: 11px; }

.hit { padding: 7px 2px; border-bottom: 1px solid var(--border-soft); }
.hit-top { display: flex; align-items: baseline; gap: 6px; }
.hit-top .num { color: var(--muted); }
.hit-top .num.good { color: var(--ok); }
.hit-f { margin-left: auto; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hit-c { color: var(--muted); font-size: 11px; margin-top: 4px; line-height: 1.55; }

.metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 8px 0; }
.metric {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 7px 9px; display: flex; flex-direction: column; gap: 1px;
}
.mk { color: var(--muted); font-size: 11px; }
.mv { font-size: 15px; font-weight: 600; }

.cmd {
  margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--surface); border: 1px solid var(--border); font-family: var(--mono); font-size: 11px;
}

.todo {
  margin-top: 12px; padding: 8px 10px; border-radius: var(--radius);
  border: 1px dashed var(--border); color: var(--muted); font-size: 11px; line-height: 1.75;
}
.todo-h { color: var(--text); font-weight: 600; margin-bottom: 3px; }
</style>
