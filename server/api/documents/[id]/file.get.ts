/**
 * 取原始文件：给「来源」面板的在线预览用（也兼容 ?download=1 直接下载）。
 *
 * 两个安全点：
 *   1) 先按「本人」查一次 documents —— 拿别人的 id 查不到，直接 404；
 *   2) 真正读存储走管理端客户端，因为私有桶没有面向普通用户的策略，
 *      能不能读在上一句已经判定过了。
 */
function contentTypeOf(ext: string) {
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'md' || ext === 'markdown') return 'text/markdown; charset=utf-8'
  if (ext === 'json') return 'application/json; charset=utf-8'
  if (ext === 'csv') return 'text/csv; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, statusMessage: '缺少文档 id' })

  const user = await requireUser(event)
  const db = supabaseAsUser(event)

  const { data: doc, error } = await db
    .from('documents')
    .select('id, filename, storage_path')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle()

  if (error) {
    throw createError({ statusCode: 500, statusMessage: '读取文档失败', data: error.message })
  }
  if (!doc) {
    throw createError({ statusCode: 404, statusMessage: '文档不存在' })
  }

  const storage = supabaseServer(event)
  const { data: blob, error: dlError } = await storage.storage.from('docs').download(doc.storage_path)
  if (dlError || !blob) {
    throw createError({ statusCode: 404, statusMessage: '原始文件读取失败', data: dlError?.message })
  }

  const ext = (String(doc.filename).split('.').pop() || '').toLowerCase()
  const download = Boolean(getQuery(event)?.download)
  setHeader(event, 'Content-Type', contentTypeOf(ext))
  setHeader(
    event,
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(doc.filename)}`,
  )
  // 原始文件不会变，可以放心让浏览器缓存一会儿，减少重复下载
  setHeader(event, 'Cache-Control', 'private, max-age=300')

  return Buffer.from(await blob.arrayBuffer())
})
