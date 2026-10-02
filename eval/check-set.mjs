/**
 * 评测集规范性校验（不需要网络、不需要密钥，可以放进 CI）。
 *
 * 防的是这种情况：有人改题目时不小心删了一条、把 expect 写错，
 * 跑分结果看着正常，其实评测集本身已经坏了。
 */
import { questions } from './questions.mjs'

const problems = []
const seen = new Set()

for (const q of questions) {
  if (typeof q.id !== 'number') problems.push(`第 ${q.id} 题缺少数字 id`)
  if (seen.has(q.id)) problems.push(`id 重复：${q.id}`)
  seen.add(q.id)
  if (typeof q.q !== 'string' || !q.q.trim()) problems.push(`#${q.id} 题干为空`)
  if (!['answer', 'refuse'].includes(q.expect)) problems.push(`#${q.id} expect 只能是 answer / refuse`)
  if (!['in-doc', 'adjacent', 'off-topic'].includes(q.type)) problems.push(`#${q.id} type 不在约定范围内`)
}

const count = (t) => questions.filter(q => q.type === t).length
const shouldAnswer = questions.filter(q => q.expect === 'answer').length
const shouldRefuse = questions.filter(q => q.expect === 'refuse').length

if (questions.length < 10) problems.push(`题量太少（${questions.length}），至少 10 题才能说明问题`)
if (shouldAnswer < 5) problems.push(`应答题只有 ${shouldAnswer} 题`)
if (shouldRefuse < 3) problems.push(`应拒答题只有 ${shouldRefuse} 题，拒答能力测不出来`)
if (count('adjacent') < 1) problems.push('缺少「相关但材料没写」这一类，这是最容易骗过阈值的情况')

console.log(`评测集：${questions.length} 题`)
console.log(`  文档内 ${count('in-doc')} · 相关但没写 ${count('adjacent')} · 完全无关 ${count('off-topic')}`)
console.log(`  期望回答 ${shouldAnswer} · 期望拒答 ${shouldRefuse}`)

if (problems.length) {
  console.error('\n❌ 评测集有问题：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('\n✅ 评测集规范性校验通过')
