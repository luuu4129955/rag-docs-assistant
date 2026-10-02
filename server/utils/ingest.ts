import { extractText, getDocumentProxy } from 'unpdf'

export const TEXT_EXTENSIONS = ['md', 'markdown', 'txt', 'text', 'csv', 'json']

/**
 * 二进制 → 纯文本。
 * PDF 交给 unpdf，纯文本直接按 UTF-8 解码。
 * 从上传接口里抽出来，是因为解析现在跑在后台任务里，不再跟着上传请求走。
 */
export async function extractTextFromFile(data: Uint8Array, ext: string): Promise<string> {
  if (ext === 'pdf') {
    const pdf = await getDocumentProxy(data)
    const result = await extractText(pdf, { mergePages: true })
    return Array.isArray(result.text) ? result.text.join('\n\n') : result.text
  }
  return new TextDecoder('utf-8').decode(data)
}
