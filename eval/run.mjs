/**
 * RAG 评测脚本：把评测集逐题打给 /api/chat，统计四个数字。
 *
 * 用法：
 *   node eval/run.mjs                      # 默认打本地 3000
 *   RAG_EVAL_BASE=https://xxx node eval/run.mjs
 *   node eval/run.mjs --verbose            # 打印每题的回答片段
 *
 * 统计口径：
 *   服务端拒答 = 召回到候选，但一块都没过阈值（retrieved && usedCount === 0）
 *   模型拒答   = 正文里出现「材料里没有提到」这类话术
 *   带引用     = 正文里出现 [n] 或 【n】
 */
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { questions } from './questions.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const BASE = process.env.RAG_EVAL_BASE || 'http://localhost:3000'
const VERBOSE = process.argv.includes('--verbose')

const REFUSAL_PATTERNS = /材料里没有提到|没有找到和这个问题相关|无法依据材料|材料中没有/
const CITATION = /(?:\[(\d{1,2})\]|【(\d{1,2})】)/

async function ask(question) {
  const started = Date.now()
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  })

  if (!res.ok || !res.body) {
    return { error: `HTTP ${res.status}`, ms: Date.now() - started }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let text = ''
  let meta = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const parts = buf.split('\n\n')
    buf = parts.pop() ?? ''
    for (const part of parts) {
      const line = part.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const obj = JSON.parse(data)
        if (Array.isArray(obj.sources)) {
          meta = obj
          continue
        }
        const delta = obj.choices?.[0]?.delta?.content
        if (delta) text += delta
      }
      catch {}
    }
  }

  return {
    text,
    meta,
    ms: Date.now() - started,
    serverRefused: Boolean(meta?.retrieved) && (meta?.usedCount ?? 0) === 0,
    modelRefused: REFUSAL_PATTERNS.test(text),
    cited: CITATION.test(text),
    topSimilarity: meta?.sources?.length ? Math.max(...meta.sources.map(s => s.similarity)) : 0,
  }
}

const results = []

for (const item of questions) {
  const r = await ask(item.q)
  const refused = r.serverRefused || r.modelRefused
  const pass = item.expect === 'refuse' ? refused : (!refused && r.cited)
  results.push({ item, r, refused, pass })

  const mark = pass ? '✅' : '❌'
  const kind = r.error
    ? r.error
    : (r.serverRefused ? '服务端拒答' : r.modelRefused ? '模型拒答' : (r.cited ? '作答+引用' : '作答但无引用'))
  console.log(
    `${mark} #${String(item.id).padStart(2)} [${item.type}] ${kind} `
    + `最高分 ${(r.topSimilarity ?? 0).toFixed(3)} ${r.ms}ms — ${item.q}`,
  )
  if (VERBOSE && r.text) console.log(`      回答：${r.text.replace(/\n/g, ' ').slice(0, 120)}`)
}

const shouldAnswer = results.filter(x => x.item.expect === 'answer')
const shouldRefuse = results.filter(x => x.item.expect === 'refuse')

const answered = shouldAnswer.filter(x => !x.refused)
const citedRight = shouldAnswer.filter(x => !x.refused && x.r.cited)
const refusedRight = shouldRefuse.filter(x => x.refused)
const byServer = shouldRefuse.filter(x => x.r.serverRefused)

const avg = arr => (arr.length ? Math.round(arr.reduce((s, x) => s + x.r.ms, 0) / arr.length) : 0)
const maxMs = Math.max(...results.map(x => x.r.ms ?? 0))

const pct = (a, b) => `${a}/${b}（${b ? Math.round((a / b) * 100) : 0}%）`

console.log('\n================ 结果 ================')
console.log(`应答题答出率    ${pct(answered.length, shouldAnswer.length)}   ← 漏答 ${shouldAnswer.length - answered.length} 题`)
console.log(`应答题引用率    ${pct(citedRight.length, shouldAnswer.length)}   ← 答了但没标引用 ${answered.length - citedRight.length} 题`)
console.log(`应拒答题拒答率  ${pct(refusedRight.length, shouldRefuse.length)}   ← 其中服务端阈值拦下 ${byServer.length} 题，靠模型自觉 ${refusedRight.length - byServer.length} 题`)
console.log(`总通过率        ${pct(results.filter(x => x.pass).length, results.length)}`)
console.log(`平均延迟        ${avg(results)}ms   最慢 ${maxMs}ms`)
console.log(`阈值            ${results[0]?.r?.meta?.threshold ?? '未知'}`)

console.log('\nJSON 摘要：')
const summary = {
  ranAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  base: BASE,
  model: results[0]?.r?.meta?.model ?? undefined,
  threshold: results[0]?.r?.meta?.threshold ?? undefined,
  answered: `${answered.length}/${shouldAnswer.length}`,
  cited: `${citedRight.length}/${shouldAnswer.length}`,
  refused: `${refusedRight.length}/${shouldRefuse.length}`,
  refusedByServer: byServer.length,
  passed: `${results.filter(x => x.pass).length}/${results.length}`,
  avgMs: avg(results),
  maxMs,
}
console.log(JSON.stringify(summary, null, 2))

// 顺手落盘，页面上的「评测」面板会读它
try {
  writeFileSync(join(HERE, 'latest.json'), JSON.stringify(summary, null, 2), 'utf-8')
  console.log(`\n已写入 ${join(HERE, 'latest.json')}`)
}
catch (e) {
  console.warn('写入 latest.json 失败：', e?.message || e)
}

process.exit(results.every(x => x.pass) ? 0 : 1)
