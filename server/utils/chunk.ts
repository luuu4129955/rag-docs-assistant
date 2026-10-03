export type ChunkOptions = {
  size?: number
  overlap?: number
}

/**
 * 清洗从 PDF / 文本里提取出来的内容。
 * 必要性：Postgres 的 text 类型不接受 NUL（\u0000），而 PDF 解析经常产出
 * NUL 以及零散控制字符，直接入库会报 22P05 unsupported Unicode escape sequence。
 */
export function sanitizeText(input: string) {
  return input
    // 保留 \t(09) \n(0A) \r(0D)，其余控制字符一律去掉
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // 孤立代理项无法编码成合法 UTF-8
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    // PDF 常用康熙部首区的字替代常规汉字（⼀ vs 一），只对这些字符做兼容分解。
    // 不用整串 normalize('NFKC')，因为它会把中文全角标点也换成半角，影响显示效果。
    .replace(/[\u2E80-\u2EFF\u2F00-\u2FDF\uF900-\uFAFF]/g, ch => ch.normalize('NFKC'))
}

/**
 * 把长文本切成带重叠、且**带章节标题**的小块。
 *
 * 为什么要先按标题切：固定字数切法会把「三、资源优化」的正文切到「四、构建配置」那块去，
 * 检索到的块看着相关、其实上下文是错的。按标题分节后，正文不会跨节，
 * 并且每个块都带上它所属的标题——标题本身就是很强的检索信号。
 *
 * 没有标题的文本（比如 OCR 出来的 PDF）会退化成原来的行为：只有一节，按字数切。
 */
// overlap 建议取 size 的 10%~20%：太小挡不住语义被切断，太大则相邻块大量重复，
// 检索时会召回一堆内容相同的副本，浪费 token 还挤占结果名额
export function chunkText(input: string, { size = 600, overlap = 90 }: ChunkOptions = {}) {
  const text = sanitizeText(input)
    // 去掉开头的 YAML 头（--- title: ... ---）：它没有答案价值，却会被切成一个块占检索名额
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) return []

  const chunks: string[] = []

  for (const section of splitByHeadings(text)) {
    const pieces = section.body ? splitBySize(section.body, size, overlap) : []

    if (!pieces.length) {
      // 只有标题、没有正文：并进上一块，别让它单独占一个检索名额
      if (chunks.length) chunks[chunks.length - 1] += `\n${section.heading}`
      else if (section.heading) chunks.push(section.heading)
      continue
    }

    for (const piece of pieces) {
      const withHeading = section.heading ? `${section.heading}\n${piece}` : piece
      // 碎块（不足 80 字）并进上一块，避免切出"只有一句话"的块
      const prev = chunks[chunks.length - 1]
      if (prev && withHeading.length < 80 && prev.length + withHeading.length < size * 1.6) {
        chunks[chunks.length - 1] = `${prev}\n${withHeading}`
      }
      else {
        chunks.push(withHeading)
      }
    }
  }

  return chunks
}

type Section = { heading: string, body: string }

/** 按 markdown 标题把文本分成若干节；标题行本身留着，作为每块的前缀 */
function splitByHeadings(text: string): Section[] {
  const sections: Section[] = []
  let heading = ''
  let lines: string[] = []

  const flush = () => {
    const body = lines.join('\n').trim()
    if (body || heading) sections.push({ heading, body })
    lines = []
  }

  for (const line of text.split('\n')) {
    if (/^#{1,6}\s+\S/.test(line.trim())) {
      flush()
      heading = line.trim()
      continue
    }
    lines.push(line)
  }
  flush()

  return sections
}

/** 在给定文本内按字数切块，尽量落在段落/句子边界；切不动就硬切 */
function splitBySize(text: string, size: number, overlap: number): string[] {
  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = Math.min(start + size, text.length)

    if (end < text.length) {
      const window = text.slice(start, end)
      const candidates = [
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('。'),
        window.lastIndexOf('\n'),
        window.lastIndexOf('. '),
      ]
      const cut = Math.max(...candidates)
      // 只有切点足够靠后才采用，否则宁可硬切，避免切出过短的碎块
      if (cut > size * 0.5) end = start + cut + 1
    }

    const piece = text.slice(start, end).trim()
    if (piece) chunks.push(piece)

    if (end >= text.length) break
    // 保证每次至少前进 1 个字符，避免死循环
    start = Math.max(end - overlap, start + 1)
  }

  return chunks
}
