import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 返回最近一次 `node eval/run.mjs` 的结果，给页面上的「评测」面板用。
 * 没跑过就返回 404，前端会提示怎么跑。
 */
export default defineEventHandler(async (event) => {
  try {
    const raw = await readFile(join(process.cwd(), 'eval', 'latest.json'), 'utf-8')
    setHeader(event, 'Cache-Control', 'no-store')
    return JSON.parse(raw)
  }
  catch {
    throw createError({ statusCode: 404, statusMessage: '还没有评测记录' })
  }
})
