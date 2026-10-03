<script setup lang="ts">
type Source = { n: number, filename: string, idx: number, similarity: number, rerankScore?: number | null, keywordHits?: number | null, foundBy?: string[] | null, content: string }
type Hit = { id: number, filename: string, idx: number, content: string, similarity: number, rerankScore?: number | null, keywordHits?: number | null, foundBy?: string[] | null }
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
type LiveMetrics = {
  sampleSize: number
  refusalRate: number | null
  latency: { avgMs: number | null, p95Ms: number | null, firstTokenAvgMs: number | null, retrievalAvgMs: number | null }
  cache: { hits: number, hitRate: number | null }
  tokens: { prompt: number, completion: number, avgPromptPerAsk: number | null, estimatedCost: number, currency: string }
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

const { $api } = useNuxtApp()

const tabs = [
  { key: 'src' as const, label: '来源', icon: 'link' },
  { key: 'debug' as const, label: '检索调试', icon: 'search' },
  { key: 'eval' as const, label: '评测', icon: 'chart' },
]

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

// ---- 检索调试 ----
const q = ref('')
const k = ref(5)
const searching = ref(false)
const hits = ref<Hit[]>([])
const searchHint = ref('')
const liveThreshold = ref(props.threshold)
const rerankOn = ref(false)
const rerankThreshold = ref(0)

/** 判定「会不会被采用」：启用重排序时看重排分，否则看向量分 */
function accepted(h: Hit) {
  if (rerankOn.value && rerankThreshold.value > 0) {
    return (h.rerankScore ?? Number.NEGATIVE_INFINITY) >= rerankThreshold.value
  }
  return h.similarity >= liveThreshold.value
}

async function search() {
  const text = q.value.trim()
  if (!text || searching.value) return
  searching.value = true
  searchHint.value = ''
  try {
    const r = await $api('/api/search', {
      method: 'POST',
      body: { query: text, k: k.value },
    }) as { results: Hit[], threshold: number, rerank: boolean, rerankThreshold: number }
    hits.value = r.results
    liveThreshold.value = r.threshold ?? props.threshold
    rerankOn.value = Boolean(r.rerank)
    rerankThreshold.value = r.rerankThreshold ?? 0
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
const live = ref<LiveMetrics | null>(null)
const liveError = ref('')

async function refreshMetrics() {
  try {
    live.value = await $api('/api/metrics/summary') as LiveMetrics
    liveError.value = ''
  }
  catch (e: any) {
    liveError.value = e?.data?.statusMessage || '线上指标读取失败'
  }
}

onMounted(async () => {
  try {
    evalData.value = await $api('/api/eval/latest') as EvalSummary
  }
  catch {
    evalMissing.value = true
  }
  await refreshMetrics()
})

// 每次回答结束后由父组件调用，避免"必须刷新页面才看到新指标"
defineExpose({ refreshMetrics })
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
        <AppIcon :name="t.icon" :size="13" />
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
            <span class="src-s num">
              <template v-if="s.rerankScore != null">重排 {{ s.rerankScore.toFixed(3) }} · </template>{{ pct(s.similarity) }}
            </span>
          </div>
          <div v-if="s.foundBy?.length" class="src-path">
            {{ s.foundBy.includes('vector') ? '向量' : '' }}{{ s.foundBy.length > 1 ? ' + ' : '' }}{{ s.foundBy.includes('keyword') ? `关键词命中 ${s.keywordHits ?? 0} 词` : '' }}
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
        <button class="btn" :disabled="searching" @click="search">
          <AppIcon name="search" :size="13" />
          {{ searching ? '…' : '检索' }}
        </button>
      </div>
      <p class="panel-hint">
        Top-K 原始结果，<b>不过滤阈值</b>——低于 {{ Math.round(liveThreshold * 100) }}% 的只是候选。
      </p>
      <p v-if="searchHint" class="hint-warn">{{ searchHint }}</p>
      <div v-for="h in hits" :key="h.id" class="hit">
        <div class="hit-top">
          <span class="num" :class="{ good: accepted(h) }">{{ pct(h.similarity) }}</span>
          <span v-if="h.rerankScore != null" class="num rerank">重排 {{ h.rerankScore.toFixed(3) }}</span>
          <span v-if="h.foundBy?.length" class="tag path">{{ h.foundBy.includes('vector') ? '向量' : '' }}{{ h.foundBy.length > 1 ? '+' : '' }}{{ h.foundBy.includes('keyword') ? `关键词${h.keywordHits ?? 0}` : '' }}</span>
          <span v-if="!accepted(h)" class="tag">不进 prompt</span>
          <span class="hit-f">{{ h.filename }} · 第 {{ h.idx }} 块</span>
        </div>
        <p class="hit-c">{{ h.content.slice(0, 140) }}{{ h.content.length > 140 ? '…' : '' }}</p>
      </div>
    </div>

    <!-- 评测 -->
    <div v-else class="body">
      <p class="panel-hint">线上指标（真实流量）</p>
      <template v-if="live && live.sampleSize">
        <div class="metrics">
          <div class="metric"><span class="mk">样本</span><span class="mv num">{{ live.sampleSize }}</span></div>
          <div class="metric"><span class="mk">拒答率</span><span class="mv num">{{ live.refusalRate === null ? '-' : (live.refusalRate * 100).toFixed(0) + '%' }}</span></div>
          <div class="metric"><span class="mk">P95 延迟</span><span class="mv num">{{ live.latency.p95Ms ? (live.latency.p95Ms / 1000).toFixed(1) + 's' : '-' }}</span></div>
          <div class="metric"><span class="mk">首字平均</span><span class="mv num">{{ live.latency.firstTokenAvgMs ? (live.latency.firstTokenAvgMs / 1000).toFixed(1) + 's' : '-' }}</span></div>
          <div class="metric"><span class="mk">缓存命中</span><span class="mv num">{{ live.cache.hitRate === null ? '-' : (live.cache.hitRate * 100).toFixed(0) + '%' }}</span></div>
          <div class="metric">
            <span class="mk">累计成本</span>
            <span class="mv num">
              {{ live.tokens.estimatedCost > 0 ? `¥${live.tokens.estimatedCost}` : '免费额度' }}
            </span>
          </div>
        </div>
        <p class="panel-hint">
          检索平均 {{ live.latency.retrievalAvgMs ?? '-' }}ms · 每次提问平均 {{ live.tokens.avgPromptPerAsk ?? '-' }} prompt token
          · 缓存命中 {{ live.cache.hits }} 次
        </p>
      </template>
      <p v-else-if="liveError" class="panel-hint">{{ liveError }}</p>
      <p v-else class="panel-hint">还没有线上数据，问几个问题就会出现。</p>

      <hr class="sep">

      <p class="panel-hint">离线评测（15 题固定集）</p>
      <template v-if="evalData">
        <div class="metrics">
          <div class="metric"><span class="mk">答出率</span><span class="mv num">{{ evalData.answered }}</span></div>
          <div class="metric"><span class="mk">引用率</span><span class="mv num">{{ evalData.cited }}</span></div>
          <div class="metric"><span class="mk">拒答率</span><span class="mv num">{{ evalData.refused }}</span></div>
          <div class="metric"><span class="mk">平均延迟</span><span class="mv num">{{ (evalData.avgMs / 1000).toFixed(1) }}s</span></div>
        </div>
        <p class="panel-hint">
          应拒答题里只有 {{ evalData.refusedByServer }} 题是阈值拦下，其余靠模型自觉；
          最慢一次 {{ (evalData.maxMs / 1000).toFixed(1) }}s · 跑于 {{ evalData.ranAt }}
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
  display: inline-flex; align-items: center; gap: 4px;
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
.hit-top .rerank { color: var(--accent); }
.hit-top .path { color: var(--muted); }
.src-path { color: var(--muted); font-size: 10px; margin: -2px 0 4px; }
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
.sep { border: 0; border-top: 1px solid var(--border); margin: 12px 0; }
.todo-h { color: var(--text); font-weight: 600; margin-bottom: 3px; }
</style>
