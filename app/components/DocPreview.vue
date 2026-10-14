<script setup lang="ts">
/**
 * 原文在线预览：点来源卡片上的「预览原文」打开。
 *
 * 支持 PDF（嵌 iframe）和纯文本类（md / txt / csv / json，直接渲染并高亮命中块）。
 * 其它格式（比如 .docx 二进制）给下载，不硬凑。
 *
 * 文件是通过 /api/documents/:id/file 取的（带登录态、服务端做归属校验），
 * 拿到的是 blob，用 object URL 呈现——所以不会把文件地址暴露成公开链接。
 */
const props = defineProps<{
  open: boolean
  documentId: string | null
  filename: string
  chunk?: string
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { $api } = useNuxtApp()

const loading = ref(false)
const error = ref('')
const objectUrl = ref('')
const text = ref('')
const truncated = ref(false)
const kind = ref<'pdf' | 'text' | 'other'>('other')

const MAX_TEXT = 200_000

function revoke() {
  if (objectUrl.value) {
    URL.revokeObjectURL(objectUrl.value)
    objectUrl.value = ''
  }
}

async function load() {
  revoke()
  text.value = ''
  truncated.value = false
  error.value = ''
  if (!props.open || !props.documentId) return

  loading.value = true
  try {
    const blob = await $api(`/api/documents/${props.documentId}/file`, { responseType: 'blob' }) as Blob
    const ext = (props.filename.split('.').pop() || '').toLowerCase()

    if (ext === 'pdf') {
      kind.value = 'pdf'
      objectUrl.value = URL.createObjectURL(blob)
    }
    else if (['md', 'markdown', 'txt', 'text', 'csv', 'json'].includes(ext)) {
      kind.value = 'text'
      const full = await blob.text()
      if (full.length > MAX_TEXT) {
        text.value = full.slice(0, MAX_TEXT)
        truncated.value = true
      }
      else {
        text.value = full
      }
    }
    else {
      kind.value = 'other'
      objectUrl.value = URL.createObjectURL(blob)
    }
  }
  catch (e: any) {
    error.value = e?.data?.statusMessage || e?.message || '原文读取失败'
  }
  finally {
    loading.value = false
  }
}

/** 把命中块在原文里高亮出来；对不上（PDF 提取的换行差异等）就整篇平铺 */
const segments = computed<[string, string, string] | null>(() => {
  if (kind.value !== 'text' || !props.chunk) return null
  const needle = props.chunk.trim()
  if (!needle) return null
  const idx = text.value.indexOf(needle)
  if (idx < 0) return null
  return [text.value.slice(0, idx), text.value.slice(idx, idx + needle.length), text.value.slice(idx + needle.length)]
})

function download() {
  if (!objectUrl.value) return
  const a = document.createElement('a')
  a.href = objectUrl.value
  a.download = props.filename
  a.click()
}

function openInTab() {
  if (objectUrl.value) window.open(objectUrl.value, '_blank')
}

watch(() => [props.open, props.documentId], () => { void load() }, { immediate: true })
onBeforeUnmount(revoke)
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="emit('close')">
    <div class="preview">
      <header class="pv-head">
        <AppIcon name="file" :size="14" />
        <span class="pv-name" :title="props.filename">{{ props.filename }}</span>
        <span class="pv-kind">{{ kind === 'pdf' ? 'PDF' : kind === 'text' ? '文本' : '文件' }}</span>
        <span class="pv-actions">
          <button v-if="objectUrl" class="btn btn-ghost" @click="openInTab">新窗口</button>
          <button v-if="objectUrl" class="btn btn-ghost" @click="download">下载</button>
          <button class="btn btn-ghost" @click="emit('close')">
            <AppIcon name="close" :size="14" />
          </button>
        </span>
      </header>

      <div class="pv-body">
        <p v-if="loading" class="panel-hint">读取中…</p>
        <p v-else-if="error" class="pv-err">{{ error }}</p>

        <iframe v-else-if="kind === 'pdf' && objectUrl" class="pv-frame" :src="objectUrl" />

        <pre v-else-if="kind === 'text'" class="pv-text"><template v-if="segments"><span>{{ segments[0] }}</span><mark>{{ segments[1] }}</mark><span>{{ segments[2] }}</span></template><template v-else>{{ text }}</template></pre>

        <div v-else-if="kind === 'other'" class="pv-other">
          <p class="panel-hint">这个格式不支持在线预览，点右上角下载后用本地软件打开。</p>
        </div>
      </div>

      <footer v-if="truncated" class="pv-foot panel-hint">
        文件较大，只预览了前 20 万字符。
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / .38);
  display: grid;
  place-items: center;
  padding: 28px;
  z-index: 40;
}
.preview {
  width: min(860px, 100%);
  height: min(82vh, 720px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-window);
  overflow: hidden;
}
.pv-head {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 12px; border-bottom: 1px solid var(--border);
}
.pv-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv-kind {
  flex: none; font-size: 10px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px;
}
.pv-actions { margin-left: auto; display: flex; gap: 4px; }
.pv-body { flex: 1 1 auto; min-height: 0; overflow: auto; background: var(--surface-2); }
.pv-frame { width: 100%; height: 100%; border: 0; }
.pv-text {
  margin: 0; padding: 14px 16px;
  font-family: var(--mono); font-size: 12px; line-height: 1.7;
  white-space: pre-wrap; word-break: break-word; color: var(--text);
}
.pv-text :deep(mark), .pv-text mark {
  background: var(--accent-soft); color: var(--accent);
  border-radius: 3px; padding: 0 2px;
}
.pv-other { display: grid; place-items: center; height: 100%; padding: 20px; }
.pv-err { color: var(--danger); font-size: 12px; padding: 16px; }
.pv-foot { padding: 6px 12px; border-top: 1px solid var(--border); }
</style>
