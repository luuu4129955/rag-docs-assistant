import type { RetrievedChunk } from './retrieve'

export type ContextBlock = { n: number, label: string, text: string }

/**
 * 组装喂给模型的上下文。三个刻意的设计：
 *
 * 1. 小检索、大上下文：检索用小块（精准命中），喂模型时把命中块的**前后邻居**一起带上，
 *    避免答案正好跨在切口上、模型看到的是半句话。
 * 2. 预算约束：上下文不是越长越好——越长越贵，也越容易被无关内容带偏。
 *    超出预算就停止追加，而不是无脑塞满 Top-K。
 * 3. 编号与来源一一对应：块的编号就是前端来源列表里的编号，[1] 永远指向同一条。
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 3200

export async function buildContext(
  event: any,
  hits: RetrievedChunk[],
  budgetChars = DEFAULT_CONTEXT_BUDGET_CHARS,
): Promise<ContextBlock[]> {
  if (!hits.length) return []

  const db = supabaseAsUser(event)
  const docIds = [...new Set(hits.map(h => h.document_id))]

  // 一次性把涉及的文档分块取回来（文档不多时够用），再在内存里挑邻居
  const { data, error } = await db
    .from('chunks')
    .select('document_id, idx, content')
    .in('document_id', docIds)

  if (error) {
    logEvent('context.fetch_failed', { message: error.message })
  }

  const byKey = new Map<string, string>()
  for (const row of (data ?? []) as any[]) {
    byKey.set(`${row.document_id}#${row.idx}`, row.content)
  }

  const blocks: ContextBlock[] = []
  let used = 0

  for (const [i, hit] of hits.entries()) {
    const room = budgetChars - used
    // 留不出像样的空间就不再追加，避免塞进半截材料
    if (room < 200) break

    const parts: string[] = []
    for (const idx of [hit.idx - 1, hit.idx, hit.idx + 1]) {
      const text = byKey.get(`${hit.document_id}#${idx}`)
      if (text) parts.push(text)
    }

    let text = parts.length ? parts.join('\n…\n') : hit.content
    if (text.length > room) text = `${text.slice(0, room)}…`
    used += text.length

    blocks.push({
      n: i + 1,
      label: `《${hit.filename}》第 ${hit.idx} 块`,
      text,
    })
  }

  return blocks
}
