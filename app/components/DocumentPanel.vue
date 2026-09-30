<script setup lang="ts">
type Doc = {
  id: string
  filename: string
  char_count: number | null
  created_at: string
  chunkCount: number
  embeddedCount: number
}

const docs = ref<Doc[]>([])
const uploading = ref(false)
const embedding = ref(false)
const message = ref('')

async function load() {
  try {
    docs.value = await $fetch<Doc[]>('/api/documents')
  }
  catch (e) {
    console.error('读取文档列表失败', e)
  }
}

async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return

  uploading.value = true
  message.value = ''

  try {
    const form = new FormData()
    form.append('file', file)
    const r = await $fetch<{ charCount: number, chunkCount: number }>('/api/documents', {
      method: 'POST',
      body: form,
    })
    message.value = `解析完成：${r.charCount} 字，切成 ${r.chunkCount} 块。下一步点「向量化」。`
    await load()
  }
  catch (err: any) {
    const brief = err?.data?.statusMessage || err?.statusMessage || err?.message || '未知错误'
    const detail = err?.data?.data
    message.value = `上传失败：${brief}${detail ? `（${String(detail).slice(0, 120)}）` : ''}`
  }
  finally {
    uploading.value = false
    input.value = ''
  }
}

async function embedAll(documentId?: string) {
  embedding.value = true
  message.value = ''
  let total = 0

  try {
    // 服务端一次只算一小批，这里循环调用，避免单个请求超过函数超时时间
    for (let i = 0; i < 200; i++) {
      const r = await $fetch<{ embedded: number, remaining: number, done: boolean }>('/api/chunks/embed', {
        method: 'POST',
        body: { documentId },
      })
      total += r.embedded
      message.value = r.done
        ? `向量化完成：本次处理 ${total} 块`
        : `向量化中… 本次已处理 ${total} 块，剩余 ${r.remaining} 块`
      if (r.done) break
    }
    await load()
  }
  catch (err: any) {
    const brief = err?.data?.statusMessage || err?.message || '未知错误'
    const detail = err?.data?.data
    message.value = `向量化失败：${brief}${detail ? `（${String(detail).slice(0, 120)}）` : ''}`
  }
  finally {
    embedding.value = false
  }
}

const pendingCount = computed(() =>
  docs.value.reduce((sum, d) => sum + (d.chunkCount - d.embeddedCount), 0),
)

onMounted(load)
</script>

<template>
  <details class="panel" open>
    <summary>
      知识库文档
      <span class="count">{{ docs.length }}</span>
    </summary>

    <div class="body">
      <div class="actions">
        <label class="upload" :class="{ busy: uploading }">
          <input
            type="file"
            accept=".pdf,.md,.markdown,.txt,.csv,.json"
            :disabled="uploading"
            @change="onPick"
          >
          <span>{{ uploading ? '解析中…' : '选择文件上传' }}</span>
        </label>

        <button
          class="embed"
          :disabled="embedding || !docs.length"
          @click="embedAll()"
        >
          {{ embedding ? '向量化中…' : `向量化${pendingCount ? `（待处理 ${pendingCount} 块）` : ''}` }}
        </button>
      </div>

      <p v-if="message" class="tip">{{ message }}</p>

      <ul v-if="docs.length" class="docs">
        <li v-for="d in docs" :key="d.id">
          <span class="name">{{ d.filename }}</span>
          <span class="meta">
            {{ d.char_count ?? '-' }} 字 ·
            分块 {{ d.chunkCount }} ·
            向量 {{ d.embeddedCount }}/{{ d.chunkCount }}
          </span>
        </li>
      </ul>
      <p v-else class="empty">
        还没有文档。上传一份 PDF 或 Markdown 试试解析效果。
      </p>
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
summary {
  cursor: pointer;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 6px;
}
.count {
  background: #eef4ff;
  color: #2563eb;
  border-radius: 10px;
  padding: 0 8px;
  font-size: 12px;
  font-weight: 500;
}
.body { margin-top: 12px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.upload {
  display: inline-block;
  border: 1px dashed #bbb;
  border-radius: 8px;
  padding: 8px 14px;
  cursor: pointer;
  font-size: 14px;
}
.upload.busy { opacity: .6; cursor: progress; }
.upload input { display: none; }
.embed {
  border: 1px solid #2563eb;
  color: #2563eb;
  background: #fff;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 14px;
  cursor: pointer;
}
.embed:disabled { opacity: .5; cursor: not-allowed; }
.tip { color: #2563eb; font-size: 13px; margin: 10px 0 0; }
.docs { list-style: none; padding: 0; margin: 12px 0 0; }
.docs li {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid #f0f0f0;
  font-size: 14px;
}
.docs li:last-child { border-bottom: none; }
.name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta { flex: none; color: #888; font-size: 13px; }
.empty { color: #999; font-size: 13px; margin: 10px 0 0; }
</style>
