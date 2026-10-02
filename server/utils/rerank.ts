/**
 * 重排序：向量检索只能判断「语义像不像」，reranker 判断的是「这段材料能不能回答问题」。
 * 典型用法是两段式——向量检索先粗召回 Top-N，reranker 再精排出 Top-K。
 *
 * 注意：BAAI/bge-reranker-v2-m3 在硅基流动上返回的是**未归一化的原始分数**，
 * 数值范围跟模型绑定，不能拿"0.5 以上算相关"这种直觉当阈值——
 * 必须先用自己的数据看分布（本项目用 eval/calibrate-rerank.mjs 做这件事）。
 */
export type RerankItem = { index: number, score: number }

export function rerankConfigured(event: any) {
  const config = useRuntimeConfig(event)
  return Boolean(String(config.embeddingKey || '').trim())
}

export async function rerankTexts(
  event: any,
  query: string,
  documents: string[],
  topN: number,
): Promise<RerankItem[]> {
  const config = useRuntimeConfig(event)
  const key = String(config.embeddingKey || '').trim()
  const base = String(config.rerankBase || config.embeddingBase || '').replace(/\/+$/, '')
  const model = String(config.rerankModel || 'BAAI/bge-reranker-v2-m3')

  if (!key || !documents.length) return []

  const res = await fetch(`${base}/rerank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      query,
      documents,
      top_n: Math.min(topN, documents.length),
      return_documents: false,
    }),
  })

  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`rerank ${res.status}: ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  return (data?.results ?? []).map((r: any) => ({
    index: Number(r.index),
    score: Number(r.relevance_score),
  }))
}
