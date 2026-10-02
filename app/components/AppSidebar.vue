<script setup lang="ts">
type Doc = {
  id: string
  filename: string
  char_count: number | null
  chunkCount: number
  embeddedCount: number
}
type Conversation = { id: string, title: string | null, created_at: string }

const props = defineProps<{
  docs: Doc[]
  conversations: Conversation[]
  activeId: string | null
  uploading?: boolean
  embedding?: boolean
  chatModel?: string
  userEmail?: string
}>()

const emit = defineEmits<{
  (e: 'new-chat'): void
  (e: 'select-chat', id: string): void
  (e: 'upload', file: File): void
  (e: 'embed'): void
  (e: 'logout'): void
}>()

const fileInput = ref<HTMLInputElement | null>(null)

const pendingCount = computed(() =>
  props.docs.reduce((sum, d) => sum + Math.max(0, d.chunkCount - d.embeddedCount), 0),
)

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  emit('upload', file)
  input.value = ''
}

function shortTime(iso: string) {
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}
</script>

<template>
  <aside class="side">
    <div class="brand">
      <span class="logo">◇</span>
      <div class="brand-text">
        <span class="name">Docs QA</span>
        <span class="sub">{{ chatModel || '未配置模型' }}</span>
      </div>
    </div>

    <button class="btn new" @click="emit('new-chat')">
      <AppIcon name="plus" /> 新对话
    </button>

    <div class="scroll">
      <p class="label">会话</p>
      <button
        v-for="c in conversations"
        :key="c.id"
        class="conv"
        :class="{ on: c.id === activeId }"
        @click="emit('select-chat', c.id)"
      >
        <span class="conv-t">{{ c.title || '未命名对话' }}</span>
        <span class="conv-s">{{ shortTime(c.created_at) }}</span>
      </button>
      <p v-if="!conversations.length" class="label empty">还没有会话</p>

      <p class="label kb-label">知识库</p>
      <div v-for="d in docs" :key="d.id" class="doc">
        <AppIcon name="file" :size="13" class="doc-i" />
        <span class="doc-n">{{ d.filename }}</span>
        <span class="doc-m num">{{ d.embeddedCount }}/{{ d.chunkCount }}</span>
      </div>
      <p v-if="!docs.length" class="label empty">还没有文档</p>
    </div>

    <div class="foot">
      <p v-if="pendingCount" class="warn">还有 {{ pendingCount }} 块没向量化</p>
      <div class="foot-actions">
        <button class="btn" :disabled="uploading" @click="fileInput?.click()">
          <AppIcon name="upload" />
          {{ uploading ? '解析中…' : '上传' }}
        </button>
        <button
          class="btn"
          :disabled="embedding || !pendingCount"
          @click="emit('embed')"
        >
          <AppIcon name="sparkles" />
          {{ embedding ? '处理中…' : '向量化' }}
        </button>
      </div>
      <div class="me">
        <span class="me-mail" :title="props.userEmail">{{ props.userEmail || '未登录' }}</span>
        <button class="btn-ghost me-out" @click="emit('logout')">退出</button>
      </div>
      <input
        ref="fileInput"
        class="hide"
        type="file"
        accept=".pdf,.md,.markdown,.txt,.csv,.json"
        @change="onPick"
      >
    </div>
  </aside>
</template>

<style scoped>
.side {
  width: 232px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--side);
  border-right: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 9px; padding: 12px 12px 8px; }
.logo { font-size: 16px; color: var(--accent); }
.brand-text { display: flex; flex-direction: column; min-width: 0; }
.name { font-weight: 600; }
.sub { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.new { margin: 0 12px 8px; text-align: left; }

.scroll { flex: 1 1 auto; overflow-y: auto; padding: 0 8px 8px; }
.label { color: var(--muted); font-size: 11px; margin: 10px 4px 4px; }
.kb-label { margin-top: 14px; }
.empty { opacity: .7; }

.conv {
  display: flex; flex-direction: column; gap: 2px; width: 100%;
  padding: 7px 9px; border: 0; border-radius: 8px; background: transparent; text-align: left;
}
.conv:hover { background: var(--surface-2); }
.conv.on { background: var(--accent-soft); }
.conv-t { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.conv-s { color: var(--muted); font-size: 11px; }

.doc {
  display: flex; align-items: center; gap: 8px; padding: 4px;
  color: var(--muted); font-size: 12px;
}
.doc-i { opacity: .7; }
.doc-n { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.doc-m { flex: none; }

.foot { border-top: 1px solid var(--border); padding: 10px 12px 12px; }
.warn {
  margin-bottom: 8px; padding: 5px 8px; border-radius: var(--radius-sm);
  background: var(--warn-soft); color: var(--warn); font-size: 11px;
}
.foot-actions { display: flex; gap: 6px; }
.foot-actions .btn { flex: 1 1 0; }
.me {
  display: flex; align-items: center; gap: 8px; margin-top: 8px;
  font-size: 11px; color: var(--muted);
}
.me-mail { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me-out {
  flex: none; border: 0; background: transparent; color: var(--muted);
  padding: 2px 6px; border-radius: var(--radius-sm); font-size: 11px;
}
.me-out:hover { background: var(--surface-2); color: var(--text); }
.hide { display: none; }
</style>
