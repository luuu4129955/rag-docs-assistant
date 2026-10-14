/**
 * 分片上传 + 断点续传（前端侧）。
 *
 * 流程：init（拿 uploadId 和「已收到哪些分片」）→ 逐片传 → complete（服务端合并）。
 *
 * 「断点续传」在这里的真实含义：浏览器没法在刷新后用 File 句柄自动续传
 * （文件内容读不到了），所以做法是——
 *   1) 每次上传前把 {文件名,大小,修改时间} 当指纹发给服务端；
 *   2) 服务端按指纹找回没传完的会话，并返回已收到的分片序号；
 *   3) 用户重新选中同一个文件时，只补没传的那几片。
 * 也就是说：断的是「已经传上去的分片」，不是「还没读的文件」。
 *
 * 分片失败会重传（最多 3 次，间隔递增）——弱网下这个很关键，
 * 一个 40MB 的文件不该因为第 37 片抖一下就整个重来。
 */
export type UploadProgress = {
  filename: string
  doneParts: number
  totalParts: number
  resumed: boolean
  done: boolean
}

type Api = (path: string, options?: Record<string, any>) => Promise<any>

const MAX_PART_RETRY = 3
const PENDING_KEY = 'docsqa.upload.pending.v1'

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 指纹 = 文件名 + 大小 + 修改时间。同一个文件重复选，指纹一致，才能续传。 */
function fingerprintOf(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`
}

function rememberPending(entry: { fingerprint: string, filename: string, size: number, uploadId: string }) {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    const list: any[] = raw ? JSON.parse(raw) : []
    const next = list.filter(x => x?.fingerprint !== entry.fingerprint)
    next.push(entry)
    localStorage.setItem(PENDING_KEY, JSON.stringify(next.slice(-20)))
  }
  catch {}
}

function forgetPending(fingerprint: string) {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    if (!raw) return
    const list: any[] = JSON.parse(raw)
    localStorage.setItem(PENDING_KEY, JSON.stringify(list.filter(x => x?.fingerprint !== fingerprint)))
  }
  catch {}
}

export function useUpload() {
  /** 本地记着但没传完的上传：左栏可以提示「上次没传完」。 */
  function pendingUploads(): Array<{ fingerprint: string, filename: string, size: number }> {
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      const list: any[] = raw ? JSON.parse(raw) : []
      return list.map(x => ({ fingerprint: x.fingerprint, filename: x.filename, size: x.size }))
    }
    catch {
      return []
    }
  }

  async function upload(
    file: File,
    api: Api,
    onProgress?: (p: UploadProgress) => void,
  ): Promise<{ id: string, filename: string, status: string }> {
    const fingerprint = fingerprintOf(file)
    const init = await api('/api/documents/upload/init', {
      method: 'POST',
      body: { filename: file.name, size: file.size, fingerprint },
    }) as { uploadId: string, chunkSize: number, totalParts: number, received: number[], resumed: boolean }

    const { uploadId, chunkSize, totalParts, resumed } = init
    const have = new Set<number>(init.received ?? [])
    rememberPending({ fingerprint, filename: file.name, size: file.size, uploadId })

    let done = have.size
    onProgress?.({ filename: file.name, doneParts: done, totalParts, resumed, done: false })

    for (let i = 0; i < totalParts; i++) {
      if (have.has(i)) continue

      const start = i * chunkSize
      const blob = file.slice(start, Math.min(start + chunkSize, file.size))

      let attempt = 0
      for (;;) {
        try {
          const form = new FormData()
          form.append('index', String(i))
          form.append('part', blob, `${file.name}.part${i}`)
          await api(`/api/documents/upload/${uploadId}/part`, { method: 'POST', body: form })
          break
        }
        catch (e) {
          attempt++
          if (attempt >= MAX_PART_RETRY) throw e
          await sleep(400 * attempt)
        }
      }

      done++
      onProgress?.({ filename: file.name, doneParts: done, totalParts, resumed, done: false })
    }

    const doc = await api(`/api/documents/upload/${uploadId}/complete`, { method: 'POST' }) as {
      id: string
      filename: string
      status: string
    }
    forgetPending(fingerprint)
    onProgress?.({ filename: file.name, doneParts: totalParts, totalParts, resumed, done: true })
    return doc
  }

  return { upload, pendingUploads }
}
