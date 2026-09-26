<script setup lang="ts">
const props = defineProps<{ text: string }>()

const html = ref('')
let timer: ReturnType<typeof setTimeout> | undefined

watch(() => props.text, () => {
  if (import.meta.server) return
  clearTimeout(timer)
  // 流式输出时每个字都重新解析一次太浪费，合并成 80ms 一次
  timer = setTimeout(async () => {
    const raw = props.text || ''
    if (!raw.trim()) {
      html.value = ''
      return
    }
    const { marked } = await import('marked')
    const DOMPurify = (await import('dompurify')).default
    const parsed = marked.parse(raw, { async: false, breaks: true }) as string
    // 模型输出可能被提示注入带上脚本，一律净化后再渲染
    html.value = DOMPurify.sanitize(parsed)
  }, 80)
}, { immediate: true })
</script>

<template>
  <div class="text md">
    <div v-if="html" v-html="html" />
    <template v-else>{{ text || '…' }}</template>
  </div>
</template>

<style scoped>
.md {
  flex: 1;
  min-width: 0;
  line-height: 1.7;
  word-break: break-word;
}
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md :deep(h1), .md :deep(h2), .md :deep(h3), .md :deep(h4) {
  margin: 14px 0 8px;
  line-height: 1.4;
}
.md :deep(h1) { font-size: 1.25rem; }
.md :deep(h2) { font-size: 1.1rem; }
.md :deep(h3) { font-size: 1rem; }
.md :deep(p) { margin: 8px 0; }
.md :deep(ul), .md :deep(ol) { margin: 8px 0; padding-left: 22px; }
.md :deep(li) { margin: 4px 0; }
.md :deep(code) {
  background: rgba(0, 0, 0, .07);
  padding: 1px 5px;
  border-radius: 4px;
  font-size: .9em;
}
.md :deep(pre) {
  background: #1f2430;
  color: #e6e6e6;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
}
.md :deep(pre code) { background: none; padding: 0; color: inherit; }
.md :deep(blockquote) {
  margin: 8px 0;
  padding-left: 12px;
  border-left: 3px solid #d0d0d0;
  color: #555;
}
.md :deep(table) { border-collapse: collapse; margin: 8px 0; }
.md :deep(th), .md :deep(td) { border: 1px solid #ddd; padding: 4px 8px; }
.md :deep(a) { color: #2563eb; }
</style>
