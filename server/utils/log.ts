/**
 * 结构化日志：一行一个 JSON。
 * 好处是能在平台日志里按字段搜（比如 event=chat.error、userId=xxx），
 * 而不是靠肉眼在中文句子堆里找。
 */
export function logEvent(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }))
}
