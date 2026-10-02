import { extractText, getDocumentProxy } from 'unpdf'

// Vercel 函数对请求体有硬限制（约 4.5MB），这里留出余量
const MAX_BYTES = 4 * 1024 * 1024
const TEXT_EXTENSIONS = ['md', 'markdown', 'txt', 'text', 'csv', 'json']

export default defineEventHandler(async (event) => {
  const form = await readMultipartFormData(event)
  const file = form?.find(part => part.name === 'file' && part.filename)

  if (!file) {
    throw createError({ statusCode: 400, statusMessage: '没有收到文件' })
  }
  if (file.data.length > MAX_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: `文件超过 ${MAX_BYTES / 1024 / 1024}MB 限制（Vercel 函数请求体上限）`,
    })
  }

  const filename = file.filename as string
  const ext = (filename.split('.').pop() || '').toLowerCase()
  const isPdf = ext === 'pdf'

  if (!isPdf && !TEXT_EXTENSIONS.includes(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: `暂不支持 .${ext} 格式，请上传 PDF / Markdown / TXT`,
    })
  }

  // 解析：PDF 交给 unpdf，纯文本直接按 UTF-8 解码
  let text = ''
  try {
    if (isPdf) {
      const pdf = await getDocumentProxy(new Uint8Array(file.data))
      const result = await extractText(pdf, { mergePages: true })
      text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text
    }
    else {
      text = new TextDecoder('utf-8').decode(file.data)
    }
  }
  catch (e: any) {
    console.error('[documents] 解析失败', e)
    throw createError({ statusCode: 400, statusMessage: '文件解析失败，可能已损坏或加密', data: e?.message })
  }

  // 先清洗再统计，保证入库的字符数与实际内容一致
  text = sanitizeText(text)

  const chunks = chunkText(text)
  if (!chunks.length) {
    throw createError({
      statusCode: 400,
      statusMessage: '没有解析出文字内容（扫描版 PDF 需要先做 OCR）',
    })
  }

  const user = await requireUser(event)
  const db = supabaseAsUser(event)
  // 私有桶没有面向普通用户的策略，存储走管理端客户端；
  // 归属靠「路径前缀 = 用户 id」+ 数据库 user_id 双重对应
  const storage = supabaseServer(event)

  // 存储键 = 用户目录 + 随机名：原始文件名可能有中文、空格、重名，真名存在数据库里
  const storagePath = `${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`
  const { error: uploadError } = await storage.storage
    .from('docs')
    .upload(storagePath, file.data, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    console.error('[documents] 上传存储失败', uploadError)
    throw createError({ statusCode: 500, statusMessage: '文件上传到存储失败', data: uploadError.message })
  }

  const { data: doc, error: docError } = await db
    .from('documents')
    .insert({
      user_id: user.id,
      filename,
      storage_path: storagePath,
      size_bytes: file.data.length,
      char_count: text.length,
    })
    .select('id, filename, char_count, created_at')
    .single()

  if (docError || !doc) {
    console.error('[documents] 写入文档记录失败', docError)
    // 补偿：把已经传上去的文件删掉，避免留下无主文件
    await storage.storage.from('docs').remove([storagePath])
    const hint = /user_id/.test(docError?.message ?? '') ? '（数据库还没执行 sql/01-auth-rls.sql）' : ''
    throw createError({ statusCode: 500, statusMessage: `写入文档记录失败${hint}`, data: docError?.message })
  }

  const { error: chunkError } = await db.from('chunks').insert(
    chunks.map((content, idx) => ({
      document_id: doc.id,
      idx,
      content,
      char_count: content.length,
    })),
  )

  if (chunkError) {
    console.error('[documents] 写入分块失败', chunkError)
    // 补偿：级联删除会带走已写入的分块，存储里的文件也一并清理
    await db.from('documents').delete().eq('id', doc.id)
    await storage.storage.from('docs').remove([storagePath])
    throw createError({ statusCode: 500, statusMessage: '写入分块失败', data: chunkError.message })
  }

  // 统一返回驼峰命名，前端不用去猜数据库的字段风格
  return {
    id: doc.id,
    filename: doc.filename,
    charCount: text.length,
    chunkCount: chunks.length,
    preview: text.slice(0, 200),
  }
})
