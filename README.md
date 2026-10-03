# Docs QA · 文档智能问答助手

上传文档，基于文档内容提问，得到带原文引用的回答；材料里没有的问题直接拒答。

> 技术栈：Nuxt 4 · TypeScript · Supabase (Postgres + pgvector + Storage) · DeepSeek API · BGE-M3
> 在线演示：（部署后补上）

## 功能

- **流式回答**：SSE 逐字输出，不用等整段生成完
- **多轮对话**：历史随请求带上，模型无需服务端记忆
- **会话持久化**：消息存在 Postgres，刷新页面不丢
- **文档进库**：上传 PDF / Markdown / TXT → 解析 → 清洗 → 分块 → 向量化
- **向量检索**：pgvector + HNSW 索引，按余弦相似度取回最相关的分块
- **带引用回答**：召回的块拼进 prompt，答案里用 `[1][2]` 标注依据，可点开看原文
- **拒答**：最高相似度低于阈值时直接回答「材料里没有」，不调用模型
- **检索调试**：页面上直接看「这个问题召回了哪几块、相似度多少」
- **服务端设防**：入参校验、历史截断、密钥只存在于服务端

## 架构

```mermaid
flowchart LR
  A[Vue 页面] -->|POST /api/chat| B[Nitro 服务端]
  B -->|1 向量化问题| E[Embedding API]
  B -->|2 检索 match_chunks| D[(Postgres + pgvector)]
  B -->|3 带材料的 prompt| C[DeepSeek API]
  C -->|SSE| A
  A -->|POST /api/documents| B
  B -->|原件| F[Supabase Storage]
  A -->|POST /api/messages| D
  D -->|GET 历史| A
```

所有密钥只存在于服务端运行时配置，浏览器永远拿不到。

## 本地运行

```bash
pnpm install
cp .env.example .env   # 填入自己的密钥
pnpm dev
```

需要 Node 20.12 以上（仓库内 `.nvmrc` 指定了 24）。

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `NUXT_DEEPSEEK_KEY` | 聊天模型密钥（默认服务商的密钥） |
| `NUXT_CHAT_KEY` | 聊天模型密钥，不填则复用 `NUXT_DEEPSEEK_KEY` |
| `NUXT_CHAT_BASE` | 聊天接口地址，默认 `https://api.deepseek.com` |
| `NUXT_CHAT_MODEL` | 聊天模型名，默认 `deepseek-chat` |
| `NUXT_EMBEDDING_KEY` | 向量化接口密钥（硅基流动） |
| `NUXT_EMBEDDING_BASE` | 向量化接口地址，默认 `https://api.siliconflow.cn/v1` |
| `NUXT_EMBEDDING_MODEL` | 向量化模型，默认 `BAAI/bge-m3`（1024 维） |
| `NUXT_SUPABASE_URL` | Supabase 项目地址 |
| `NUXT_SUPABASE_SERVICE_KEY` | Supabase secret key，仅服务端使用 |
| `NUXT_RAG_TOP_K` | 每次检索取回几块，默认 6 |
| `NUXT_RAG_THRESHOLD` | 向量相似度阈值，默认 0.35（重排序未标定时用它判定拒答） |
| `NUXT_RERANK_MODEL` | 重排序模型，默认 `BAAI/bge-reranker-v2-m3` |
| `NUXT_RERANK_TOP_N` | 向量粗召回条数，默认 20 |
| `NUXT_RERANK_THRESHOLD` | 重排序阈值，默认 0.1（**原始分**，必须自己标定，见下） |
| `NUXT_EMBEDDING_CACHE` | 向量缓存开关，默认开 |
| `NUXT_ANSWER_CACHE` | 答案缓存开关，默认开 |
| `NUXT_CACHE_TTL_DAYS` | 答案缓存有效期，默认 7 天 |
| `NUXT_PRICE_IN_PER_M` / `NUXT_PRICE_OUT_PER_M` | 每百万 token 单价（元），默认 0 = 面板显示「免费额度」 |
| `NUXT_JOBS_SECRET` | 后台任务密钥，定时任务带它调用 `/api/jobs/tick`（也兼容 Vercel 的 `CRON_SECRET`） |

## 上传与向量化：为什么是后台任务

上传接口现在只做两件便宜的事：把文件存进桶、写一条 `status = pending` 的记录，然后立刻返回。
解析、分块、向量化交给 `/api/jobs/tick` 分轮执行——它一次只解析 1 份、向量化 16 块，
为的是不撞 Serverless 函数 10 秒的超时上限。

```
上传 ──▶ documents.status = pending ──▶ tick：解析+分块 ──▶ status = embedding
                                            │
                                            └─▶ tick：向量化 16 块 ──▶ status = ready
                                                                    （出错则 failed + error）
```

三条驱动路径，任选其一都能推进：

- 前端轮询（本地开发默认）：上传后循环调用 `tick`，处理完自动停
- 页面上的「继续处理」按钮：上次没跑完的手动接着跑
- 定时任务：`vercel.json` 里配了每天一次（**Vercel Hobby 套餐只允许每天一次的 Cron**，
  想每分钟跑要升级 Pro）。所以线上主要靠前端轮询推进，Cron 只是"用户关了页面第二天也能补上"的兜底

幂等性靠两处保证：解析前先删掉该文档的旧分块再重写；向量化只挑 `embedding is null` 的行。
所以同一个文档重复处理不会产生重复数据。

聊天模型只要是 OpenAI 兼容接口就能换。例如 DeepSeek 余额用尽时，可以直接借道硅基流动的免费模型继续开发：

```
NUXT_CHAT_KEY=sk-硅基流动的密钥
NUXT_CHAT_BASE=https://api.siliconflow.cn/v1
NUXT_CHAT_MODEL=Qwen/Qwen2.5-7B-Instruct
```

换 embedding 模型比换聊天模型麻烦得多：向量维度和模型绑死，换了要改列定义并重算全部向量。

## 数据库

### 第一步：建表

```sql
create extension if not exists vector;

-- 会话与消息：引用信息跟消息存在一起，刷新后点 [1] 仍能展开原文
create table conversations (
  id uuid primary key default gen_random_uuid(),
  title text,
  created_at timestamptz not null default now()
);

create table messages (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('system','user','assistant')),
  content text not null,
  sources jsonb,
  created_at timestamptz not null default now()
);

create index messages_conversation_idx on messages (conversation_id, id);

create table documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  storage_path text not null,
  size_bytes bigint,
  char_count int,
  created_at timestamptz not null default now()
);

create table chunks (
  id bigint generated always as identity primary key,
  document_id uuid not null references documents(id) on delete cascade,
  idx int not null,
  content text not null,
  char_count int not null,
  embedding vector(1024),
  created_at timestamptz not null default now()
);

create index chunks_document_idx on chunks (document_id, idx);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
```

### 第二步：鉴权与数据隔离

执行 `sql/01-auth-rls.sql`（可重复执行）。它会做四件事：

1. 给 `conversations` / `documents` 两张根表加 `user_id`
2. 给四张表打开行级安全（RLS）
3. 建策略：根表比对 `auth.uid()`，`messages` / `chunks` 沿着外键回到根表比对
4. 把检索函数声明成 `security invoker`，保证 RLS 对检索同样生效

> 老数据的 `user_id` 为空，跑完迁移后谁都看不见。要认领给某个账号，
> 去 Authentication → Users 复制 UID，执行迁移脚本末尾注释里的两条 `update`。

### 登录是怎么走的

```
浏览器 ──POST /api/auth/login──▶ 服务端 ──signInWithPassword──▶ Supabase Auth
   ▲                                │
   └──────── access/refresh token ──┘

之后每个业务请求都带 Authorization: Bearer <access_token>
服务端用它调 auth.getUser() 验签 → 拿到 user.id
数据库查询用「带用户 token 的客户端」发出 → PostgREST 按该身份执行 → RLS 生效
```

几个刻意的选择：

- **不在浏览器里放任何 Supabase 密钥**：登录由服务端代理，前端只持有我们签发的 token
- **隔离靠数据库而不是靠代码**：每条查询都要记得加 `where user_id = ?` 太容易漏，RLS 是兜底
- 服务端仍持有 service key，但只用于两件事：校验登录态、读写存储桶

检索走一个数据库函数，把「算相似度 + 排序 + 取前 K」放在数据所在的地方做：

```sql
create or replace function match_chunks(query_embedding vector(1024), match_count int default 5)
returns table (id bigint, document_id uuid, filename text, idx int, content text, similarity float)
language sql stable as $$
  select c.id, c.document_id, d.filename, c.idx, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
```

## 开发路线

- [x] 流式对话
- [x] 多轮上下文
- [x] 会话与消息持久化
- [x] Markdown 渲染与输出净化
- [x] 文档上传、解析、分块与文本净化
- [x] 向量化（可分批续跑）与 pgvector 检索
- [x] 带引用的回答与拒答
- [x] 引用结果随消息持久化（刷新后仍能看引用）
- [x] 评测集与评测脚本（`eval/`，覆盖答出率 / 引用率 / 拒答率 / 延迟）
- [x] 上传与向量化转后台任务（状态可查、可续跑、定时任务兜底）
- [x] 重排序（向量粗召回 Top-20 → bge-reranker-v2-m3 精排 → Top-K）
- [x] 混合检索（关键词那一路 + RRF 融合，见 `sql/04-hybrid.sql`）
- [x] 缓存与成本（向量缓存 + 答案缓存 + token/成本统计）
- [ ] 评测面板 UI（把 `eval/` 的结果搬到页面上）
- [ ] 混合检索（关键词 + 向量）
- [ ] 重排序（Rerank）
- [ ] 部署上线

## 重排序：为什么需要它，阈值怎么定

向量检索只能判断「语义像不像」，判断不了「这段材料能不能回答问题」。实测：
「这套监控体系在大促期间的 QPS 峰值是多少」这种材料里根本没写的问题，
向量相似度能到 0.488（比一些真问题的 0.44 还高），阈值切不干净。

两段式检索：向量先粗召回 Top-20，再用 `BAAI/bge-reranker-v2-m3` 精排到 Top-K。

**阈值必须自己标定**：这个模型返回的是**未归一化原始分**，没有「0.5 以上算相关」这种通用值。
用 `node eval/calibrate-rerank.mjs` 把评测集跑一遍，看两类分数的分布再定。本项目实测：

| | 分数范围 | 中位 |
| --- | --- | --- |
| 应答题（10 条） | 0.153 ～ 0.981 | 0.685 |
| 应拒答题（5 条） | 0.0001 ～ 0.186 | 0.009 |

选 0.1 作为阈值后，15 题评测里「服务端阈值拦下」从 1/5 提升到 **4/5**——
拒答不再主要依赖模型自觉。

## 缓存与成本

两笔账分别用两种缓存解决：

| 缓存 | 键 | 省掉什么 |
| --- | --- | --- |
| 向量缓存 `embedding_cache` | `sha256(模型 + 文本)` | 重复的向量化调用（只存哈希和向量，不存原文，所以可以全局共用） |
| 答案缓存 `answer_cache` | `sha256(用户 + 模型 + 阈值 + Top-K + **语料版本** + 规范化问题)` | 一次完整的「向量化 + 检索 + 重排 + 模型」链路 |

**关键是失效条件**，缺一个就会出现"文档更新了但回答还是旧的"：

1. 语料变了 → `corpusVersion`（所有就绪文档的 id + 更新时间取哈希）变化 → 旧缓存自然失效
2. 参数变了（换模型、调阈值、调 Top-K）→ 这些参数进缓存键
3. 时间太久 → TTL（默认 7 天）

命中缓存的那一轮没有真实模型调用，所以**不计入 token 与成本**；指标表用 `cached` 字段区分。

## 混合检索：向量 + 关键词

向量检索的短板是「字面精确匹配」：它会把 `HNSW` 和 `HNSW 索引` 当成差不多的东西，
也可能把型号、编号、专有名词排在很后面。所以再加一路关键词检索：

- 关键词那一路走数据库函数 `search_chunks_keyword`（见 `sql/04-hybrid.sql`）：
  把查询按空格和标点切词，逐个 `ILIKE` 匹配，命中词越多分越高
  （中文没有空格，Postgres 内置全文分词对它基本无效，这是退而求其次但有效的做法）
- 两路结果用 **RRF（Reciprocal Rank Fusion）融合**：每路各排各的，把名次折算成
  `1/(60+rank)` 累加。好处是不需要把「余弦相似度」和「关键词命中数」这两种
  量纲完全不同的分数强行归一化
- 融合后再交给 reranker 精排，最后取 Top-K

调试面板里每块会标出它是被哪一路找到的：`向量` / `关键词` / `向量+关键词`。
函数没建时关键词那一路自动跳过（记 `retrieve.keyword_failed` 日志），不影响主流程。

## 评测

```bash
node eval/run.mjs              # 打本地 3000
node eval/run.mjs --verbose    # 附带每题的模型回答
```

15 道题：10 道文档内（必须答出并带引用）、3 道「相关但材料没写」、2 道完全无关（后两类必须拒答）。
统计口径写在 `eval/run.mjs` 顶部：服务端拒答 = 有候选但一块都没过阈值；模型拒答 = 正文里出现「材料里没有提到」。

## CI（GitHub Actions）

`.github/workflows/ci.yml` 在每次 push 到 main 和每个 PR 上跑三步：

1. **评测集规范性校验**（`eval/check-set.mjs`）：题量、id、`expect` / `type` 取值、三类题的比例——防的是「有人改题目时删了一条，跑分看着正常其实评测集已经坏了」
2. **生产构建**（`pnpm build`）：本地 `dev` 能跑不代表能构建，这一步专门拦这类问题
3. **启动冒烟**：真的把构建产物跑起来，打一次 `/api/health`。不需要任何密钥——它只报告「配置了没有」

本地等价命令：`pnpm verify`

**为什么第一版不接 ESLint**：这套代码从没按 lint 规则写过，直接接上会一次红一片，
而"一直红着"的 CI 等于没有 CI。lint 应该单独作为一步：先定规则、改一遍代码、再接入。

**下一步可以加的**：带密钥的完整评测回归（用 GitHub Secrets 存 Supabase 与模型密钥，
`workflow_dispatch` 手动触发），以及 lint。

## 已知取舍

- **单次请求体上限 4MB**：Vercel 函数限制，大文件需要改成浏览器直传 Storage
- **扫描版 PDF 不支持**：没有文字层，需要先做 OCR
- **分块数在内存里统计**：文档量大时应改成数据库聚合查询
- **换 embedding 模型要整库重算**：向量维度与模型绑死

## 许可证

MIT
