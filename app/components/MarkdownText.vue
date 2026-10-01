<script setup lang="ts">
const props = defineProps<{ text: string, citeCount?: number }>()
const emit = defineEmits<{ (e: 'cite', n: number): void }>()

const html = ref('')
const box = ref<HTMLElement | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined

/**
 * 把正文里的 [1] 变成可点的引用标记。
 * 只在标签之外替换，避免动到属性里的内容；净化之后再做，免得被 DOMPurify 清掉。
 */
function linkCitations(safeHtml: string, max: number) {
  if (!max) return safeHtml
  // 代码块和链接里的 [1] 是代码或链接本身，不能当成引用标记
  let skipDepth = 0
  return safeHtml
    .split(/(<[^>]*>)/)
    .map((seg) => {
      if (seg.startsWith('<')) {
        const tag = seg.match(/^<\/?\s*([a-z0-9]+)/i)?.[1]?.toLowerCase()
        if (tag === 'code' || tag === 'pre' || tag === 'a') {
          if (seg.startsWith('</')) skipDepth = Math.max(0, skipDepth - 1)
          else if (!seg.endsWith('/>')) skipDepth++
        }
        return seg
      }
      if (skipDepth > 0) return seg
      // 半角 [1] 和全角 【1】 都算引用（模型两种都可能写）
      return seg.replace(/(?:\[(\d{1,2})\]|【(\d{1,2})】)/g, (raw, half, full) => {
        const n = Number(half ?? full)
        if (!Number.isInteger(n) || n < 1 || n > max) return raw
        // 保留方括号：回答里的 [1] 和下面的来源 [1] 一眼能对上
        return `<span class="cite" data-cite="${n}" role="button" tabindex="0" title="点开看第 ${n} 条原文">[${n}]</span>`
      })
    })
    .join('')
}

watch(() => [props.text, props.citeCount], () => {
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
    const safe = DOMPurify.sanitize(parsed)
    html.value = linkCitations(safe, props.citeCount ?? 0)
  }, 80)
}, { immediate: true })

function onClick(e: MouseEvent) {
  const el = (e.target as HTMLElement | null)?.closest?.('[data-cite]')
  if (!el) return
  emit('cite', Number(el.getAttribute('data-cite')))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const el = (e.target as HTMLElement | null)?.closest?.('[data-cite]')
  if (!el) return
  e.preventDefault()
  emit('cite', Number(el.getAttribute('data-cite')))
}
</script>

<template>
  <div ref="box" class="text md" @click="onClick" @keydown="onKeydown">
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
.md :deep(.cite) {
  display: inline-block;
  min-width: 16px;
  margin: 0 1px;
  padding: 0 4px;
  border-radius: 4px;
  background: #e3ecff;
  color: #2563eb;
  font-size: .78em;
  line-height: 16px;
  text-align: center;
  vertical-align: super;
  cursor: pointer;
}
.md :deep(.cite:hover) { background: #d0e0ff; }
</style>
