<script setup lang="ts">
type Source = { n: number, filename: string, idx: number, similarity: number, content: string }
type Msg = {
  role: 'user' | 'assistant'
  content: string
  sources?: Source[]
  usedCount?: number
  threshold?: number
  refusal?: boolean
}

const props = defineProps<{ message: Msg, index: number, streaming?: boolean }>()
const emit = defineEmits<{ (e: 'cite', n: number): void }>()
</script>

<template>
  <div v-if="props.message.role === 'user'" class="row user">
    <p class="bubble">{{ props.message.content || '…' }}</p>
  </div>

  <div v-else class="row ai">
    <div class="avatar">AI</div>
    <div class="ai-body">
      <div v-if="props.message.refusal" class="refusal">
        未在文档中找到依据
      </div>
      <div class="card">
        <MarkdownText
          :text="props.message.content"
          :cite-count="props.message.sources?.length ?? 0"
          @cite="n => emit('cite', n)"
        />
        <span v-if="props.streaming" class="caret" />
      </div>
      <button
        v-if="props.message.sources?.length"
        class="srcs"
        @click="emit('cite', 1)"
      >
        <AppIcon name="link" :size="12" />
        来源 {{ props.message.usedCount ?? 0 }}/{{ props.message.sources.length }} · 点编号查看原文
      </button>
    </div>
  </div>
</template>

<style scoped>
.row { display: flex; gap: 10px; }
.row.user { justify-content: flex-end; }

.bubble {
  max-width: 76%;
  background: var(--accent);
  color: var(--accent-fg);
  padding: 8px 13px;
  border-radius: 14px 14px 4px 14px;
  white-space: pre-wrap;
  word-break: break-word;
}

.avatar {
  flex: none;
  width: 26px; height: 26px; margin-top: 2px;
  display: grid; place-items: center;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px; font-weight: 600;
}

.ai-body { min-width: 0; flex: 1 1 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }

.card {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 13px;
  display: flex;
  gap: 2px;
}

.refusal {
  padding: 2px 9px;
  border-radius: 999px;
  background: var(--warn-soft);
  color: var(--warn);
  font-size: 11px;
}

.srcs {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
}
.srcs:hover { color: var(--text); border-color: var(--accent); }

.caret {
  display: inline-block;
  width: 7px; height: 14px;
  margin-left: 2px;
  background: var(--accent);
  border-radius: 2px;
  animation: blink 1s steps(2, start) infinite;
}
@keyframes blink { to { opacity: 0; } }
</style>
