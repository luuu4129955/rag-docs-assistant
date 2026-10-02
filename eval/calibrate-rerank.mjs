/**
 * 重排序阈值标定（本地脚本，不入库）
 *   node eval/calibrate-rerank.mjs
 *
 * BAAI/bge-reranker-v2-m3 返回的是未归一化原始分，没有"0.5 以上算相关"这种通用阈值。
 * 这个脚本把 15 道题跑一遍，把「应答题」和「应拒答题」的分数分布摆出来，
 * 阈值要选在两者之间——这一步只能用自己的数据做。
 */
import fs from 'node:fs'
import { questions } from './questions.mjs'

const BASE = process.env.RAG_EVAL_BASE || 'http://localhost:3000'
const PROJECT = '/Users/lulu/Documents/ChatGPT/code/ai-agent/docs-qa'

const env = {}
for (const line of fs.readFileSync(`${PROJECT}/.env`, 'utf-8').split('\n')) {
  const t = line.trim()
  if (!t || t.startsWith('#') || !t.includes('=')) continue
  const [k, ...rest] = t.split('=')
  env[k.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '')
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    email: process.env.EMAIL || 'owner@docs-qa.dev',
    password: process.env.PASSWORD || 'DocsQA-2026-owner',
  }),
}).then(r => r.json())
const token = login?.session?.accessToken
if (!token) {
  console.error('登录失败：', JSON.stringify(login).slice(0, 200))
  process.exit(1)
}

const rows = []
for (const item of questions) {
  const res = await fetch(`${BASE}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query: item.q, k: 5 }),
  }).then(r => r.json())

  const top = res.results?.[0]
  rows.push({
    id: item.id,
    expect: item.expect,
    cosine: top?.similarity ?? 0,
    rerank: top?.rerankScore ?? null,
  })
}

const fmt = (n) => (n === null || n === undefined ? '   -    ' : n.toFixed(5))

console.log('id  期望    向量分    重排序分   题目')
for (const r of rows) {
  const q = questions.find(x => x.id === r.id)
  const mark = r.expect === 'answer' ? '应答' : '应拒'
  console.log(
    `${String(r.id).padStart(2)}  ${mark}  ${r.cosine.toFixed(3)}  ${fmt(r.rerank)}  ${q.q.slice(0, 22)}`,
  )
}

const group = (kind) => rows.filter(r => r.expect === kind && r.rerank !== null).map(r => r.rerank)
const answerable = group('answer')
const refusable = group('refuse')
const stats = (arr) => arr.length
  ? `最小 ${Math.min(...arr).toFixed(5)}  最大 ${Math.max(...arr).toFixed(5)}  中位 ${arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)].toFixed(5)}`
  : '无数据'

console.log(`\n应答题（${answerable.length} 条）重排序分：${stats(answerable)}`)
console.log(`应拒答题（${refusable.length} 条）重排序分：${stats(refusable)}`)

const maxRefuse = refusable.length ? Math.max(...refusable) : null
const minAnswer = answerable.length ? Math.min(...answerable) : null

if (maxRefuse !== null && minAnswer !== null) {
  if (minAnswer > maxRefuse) {
    const suggest = (minAnswer + maxRefuse) / 2
    console.log(`\n✅ 两类可分：建议 rerankThreshold 取 ${suggest.toFixed(5)}（${maxRefuse.toFixed(5)} ~ ${minAnswer.toFixed(5)} 之间）`)
  }
  else {
    console.log('\n⚠️ 两类有重叠：单一阈值切不干净，需要考虑「阈值 + 提示词兜底」或更好的分块')
    console.log(`   应拒题最高 ${maxRefuse.toFixed(5)} / 应答题最低 ${minAnswer.toFixed(5)}`)
  }
}
