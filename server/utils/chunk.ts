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
 * 把长文本切成带重叠的小块。
 * - size：每块目标字数
 * - overlap：相邻块的重叠字数，避免答案正好落在切口上被切断
 * 切的时候尽量落在段落或句子边界，切不动才硬切。
 */
// overlap 建议取 size 的 10%~20%：太小挡不住语义被切断，太大则相邻块大量重复，
// 检索时会召回一堆内容相同的副本，浪费 token 还挤占结果名额
export function chunkText(input: string, { size = 600, overlap = 90 }: ChunkOptions = {}) {
  const text = sanitizeText(input)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!text) return []

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
