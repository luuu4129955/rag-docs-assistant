# 迁移到 Python（B 档）实施方案

> 目标：把后端从 Nuxt/Nitro 换成 FastAPI + SQLAlchemy/asyncpg，
> 数据访问改为直连 Supabase 的 Postgres（不再走 PostgREST），
> **保留** Supabase Auth（签发 JWT）与 Supabase Storage。
> 前端 Nuxt 与部署在 Vercel 的部分**不动**。

---

## 进度（最新）

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| P0 | Python 环境、FastAPI 骨架、`/health` | ✅ 完成并验证（除数据库连通性） |
| P1 | `app_current_user()` + 8 条策略改写 + 应用角色 | ✅ 已在库里执行，**隔离验证通过** |
| P2–P7 | 全部 23 条接口 + 12 个服务 | ✅ 完成，`ruff` 通过、15 项单测通过、端到端冒烟通过 |
| P8 | 切换开关（`server/middleware/py-backend.ts`）、CI 兼容 | ✅ 完成，**默认关闭** |

### 已实测通过的项（2026-10-14）

- **数据隔离**（`scripts/verify_rls.py`）：app 角色不带 `BYPASSRLS`；不设身份查
  `documents`/`chunks` 返回 0 行；以用户身份只看到自己的数据、看不到别人的
- **数据库函数**：`match_chunks` / `search_chunks_keyword` / `take_token` 在 asyncpg
  下调用正常（`take_token` 容量 2 连取 3 次 → 允许/允许/拒绝）
- **端到端**（`scripts/smoke.py`）：登录、`/auth/me`、文档列表（4 份全就绪）、
  会话列表、`/search`（召回 3 块，最高相似度 0.521，rerank 开启）、指标汇总
- **18 题评测**：见下表

### 18 题评测对照

| | TS 后端 | Python 后端 |
| --- | --- | --- |
| 应答题答出率 | 13/13 | 12/13 |
| 应答题引用率 | 13/13 | 12/13 |
| 应拒答题拒答率 | 5/5 | **5/5** |
| 服务端阈值拦下 | 4 | **4** |
| 平均延迟 | 11.8s | 12.3s |

**结论**：

1. **延迟没有退步**。README 里那个 5.5s 的旧基线是 10/3 测的；同一天测两个后端，
   都是 ~12s —— 差别在厂商侧负载，不在我们的管道。（检索本身从 4.35s 优化到 2.77s，
   靠复用上游 HTTP 连接省掉了重复 TLS 握手。）
2. **拒答机制逐项一致**：拒答率 5/5、服务端阈值拦下 4 题，两个后端完全相同。
3. **唯一差异是第 2 题**，且原因已定位：那题的检索是对的（最高 rerank 0.957）、
   组装进 prompt 的上下文里确实含答案（"Trace" 出现 9 次），但 Qwen2.5-7B
   稳定地回"材料里没有提到"。**这是模型在"材料里有、但需要归纳"这类题上的能力问题，
   不是管道差异。** 想改善应该从提示词或换更强的模型入手。

### 排查过程中修掉的三个真 bug（都是"静默失败"型）

1. **`take_token` 限流完全失效**：PL/pgSQL 里 `RETURN QUERY` **不会结束函数**，
   我漏写了后面的 `RETURN;`，导致函数返回两行（一行允许、一行拒绝），
   调用方 `.one()` 报错、桶还被第二次更新覆盖 —— 令牌等于没扣。
   已修，并在 `scripts/smoke.py` 加了回归检查。
2. **JWT 验签依赖的 JWKS 抓取走代理**：PyJWT 的 `PyJWKClient` 内部用 `urllib`，
   会读取系统/环境代理，而那个代理连不通 → 报
   `<urlopen error [SSL: UNEXPECTED_EOF_WHILE_READING]>`，在我们代码里被翻译成
   **401**，看起来像"登录失效"，排查方向被完全带偏。改成用自己的 HTTP 客户端取
   JWKS（带缓存 + 密钥轮换强刷）。你的项目用 ES256。
3. **上游接口连接未复用**：向量化和重排每次新建 httpx 客户端，重复 TLS 握手。
   改成共享客户端后检索从 4.35s 降到 2.77s。

另外把「首字超时」从 120s 收紧到 30s 并加了**一次重试**：之前出现过一次
132 秒的空响应（`str(exc)` 是空串、日志里什么都看不出来）。
现在超时会记 `errorType`，实测救回过一次 `ReadTimeout`。

### 还需要你决定的一件事

现在切换开关是关的。要真正切流量，按下面的顺序逐条加白名单（见 `P8`）：

**切换方式**（验证通过后再开）：

```bash
# 1) 先只切一条最安全的，确认链路通了
NUXT_PY_BACKEND_URL=http://127.0.0.1:8000 NUXT_PY_BACKEND_PATHS=/api/health pnpm dev

# 2) 逐条加进去，任何一条出问题就从白名单删掉 —— 立即回到 TS 实现
NUXT_PY_BACKEND_PATHS=/api/health,/api/auth,/api/documents
```

Nuxt 侧中间件见 `server/middleware/py-backend.ts`：没配 `NUXT_PY_BACKEND_URL`
就完全不介入，原来的实现照常工作。

---

## 0. 这一档的边界

**做**：语言换成 Python；数据访问从 PostgREST 改成显式 SQL；自己管 RLS 会话上下文；自己验 JWT。

**不做**：换掉 Supabase Auth（继续用它签发 token）；换掉 Storage；上 Milvus / Celery / MinerU（那是下一档，等容器环境到位再说）。

**为什么是 B 档**：它换掉的正好是"后端含量最低"的那层（PostgREST 的声明式包装），
保留的是"不值得自己造的轮子"（认证、对象存储）。既拿到了 Python 后端的说服力，
又不用背认证安全债。

---

## 1. 目标架构

```
Vercel
  └── Nuxt 前端 + 转发层（已迁移的路由转发到下面，其余走原 Nitro 实现）
        │
        │ Authorization: Bearer <supabase access_token>
        ▼
容器 / 本机进程
  └── FastAPI（uvicorn）
        ├── JWT 本地验签（JWKS 公钥，带缓存）→ 得到 user.id
        ├── SQLAlchemy + asyncpg ── 直连 Supabase Postgres
        │      · 每个请求一个事务，事务内 SET LOCAL app.user_id
        │      · RLS 策略读 app_current_user()
        ├── Supabase Storage（上传/下载/签名）—— 走 REST，不变
        └── 上游模型：DeepSeek（chat）/ 硅基流动（embedding、rerank）
```

**关键变化只有一处**：以前"隔离靠 PostgREST 用 token 决定 role"，
现在"隔离靠我们自己把 user_id 放进事务上下文 + RLS 策略"。
这个上下文**必须每个请求都设**，漏一次就静默失效——这是整个迁移最危险的点。

---

## 2. 目录结构

```
api/
  main.py                  # FastAPI 实例、中间件、异常处理
  config.py                # pydantic-settings 读环境变量
  db.py                    # 两个 engine + session factory（见 3.1）
  security.py              # JWT 验签、JWKS 缓存、当前用户依赖
  deps.py                  # get_db / get_admin_db / current_user
  models/                  # SQLAlchemy ORM 模型（documents/chunks/conversations/...）
  schemas/                 # Pydantic v2 入参/出参
  repositories/            # 只写 SQL，不写业务判断
  services/                # chunk / embed / retrieve / rerank / cache / rate_limit
  routers/                 # auth documents conversations chat search jobs metrics telemetry
alembic/                   # 迁移版本
tests/                     # pytest + httpx.AsyncClient
```

对应关系：现在 `server/utils/*.ts` 的 12 个模块 → `services/` + `repositories/`；
`server/api/**` 的 23 个路由 → `routers/`。

---

## 3. 三个必须先解决的硬问题

### 3.1 RLS 的角色陷阱（最容易静默失败）

**这是本次迁移最大的坑。** PostgreSQL 里，**表的所有者和超级用户默认绕过 RLS**。
你在 Supabase 里之所以 RLS 生效，是因为 PostgREST 用 `anon` / `authenticated`
这种非所有者角色执行查询。

直连时如果图省事用 `postgres` 用户连接，**RLS 会静默失效**——查询照常返回，
但隔离没了，而且不会有任何报错。

**做法（推荐）**：建两个登录角色，两个 engine。

| 角色 | 属性 | 用途 | 连接方式 |
| --- | --- | --- | --- |
| `app_rls` | 非所有者、非 BYPASSRLS | 所有面向用户的请求 | `engine_app` |
| `app_admin` | `BYPASSRLS` | jobs/tick、cron、指标写入 | `engine_admin` |

同时给表开 `FORCE ROW LEVEL SECURITY`，这样即便将来有人误用所有者角色也挡得住。

> 需要验证：Supabase 的池化器是否接受自定义角色的连接。如果不行，
> 退回单角色方案——连接用 `postgres`，在事务内 `SET LOCAL ROLE app_rls`
> （事务级，池化器安全），URL 形如 `?options=-c%20role%3Dapp_rls` 或每条事务里显式 SET。

### 3.2 `auth.uid()` 那 15 处怎么改

现状：15 处 RLS 策略依赖 Supabase 的 `auth.uid()`（分布在 `sql/01`、`03`、`05`、`06`）。

**不要逐条改策略**——那样以后换实现又要改 15 个地方。正确做法是加一层间接：

```sql
create or replace function app_current_user() returns uuid
language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;
```

然后把 15 处 `auth.uid()` 全部替换成 `app_current_user()`。
**策略本身只做一次字符串替换**，将来换实现只改这一个函数。

**失败方向是对的**：没设 `app.user_id` 时 `current_setting(..., true)` 返回 NULL，
`user_id = NULL` 在 RLS 里视为不通过 → 查不到任何数据。
也就是**漏设会"查不到"而不是"查到别人的"**，是 fail-closed。

> 顺带一提：现在 `match_chunks` 显式接收 `owner` 参数的设计要保留。
> "RLS 第一道 + 显式 owner 第二道"这个双保险，在角色配置出错时能救命。

### 3.3 `SET LOCAL` 与事务、连接池的交互

`SET LOCAL` **只在当前事务内有效**。这带来两个必须记住的规则：

1. **每个请求一个事务**：事务开始后立刻 `SET LOCAL app.user_id`，请求结束再提交。
   不要在请求中间 commit（commit 会结束事务，`SET LOCAL` 随之失效，
   之后的查询就脱离了 RLS 上下文）。
2. **SSE 流式请求不要握住事务**：DB 操作（检索、缓存、指标）在开始流式输出前做完并释放连接，
   再返回 `StreamingResponse`。这与现在 TS 版的行为一致。

**池化器的坑**：如果用 Supabase 的 transaction 模式池（6543 端口），
asyncpg 的 prepared statement 会冲突，必须设 `statement_cache_size=0`。
更省事的做法是 B 档直接用直连（5432），反正你是容器常驻进程，不需要池化器省连接。

---

## 4. 分阶段迁移顺序

原则：**逐条切换，任何一步停下项目都可跑。**

| 阶段 | 内容 | 验收标准 | 回退方式 |
| --- | --- | --- | --- |
| **P0** 环境 | docker-compose（redis 可选）、FastAPI 骨架、连上 Supabase | `/health` 返回配置状态；一条 SQL 能查到数据 | 无影响 |
| **P1** 隔离 | 两个角色 + `app_current_user()` + FORCE RLS + 事务内 SET LOCAL | **用一个查询验证：设 user A 查不到 user B 的数据；不设 user_id 时返回空** | 策略可回滚 |
| **P2** 鉴权 | JWT 验签（JWKS 缓存）、`/auth/me` | 拿真实 token 能验出正确 user.id；过期/篡改的 token 被拒 | 前端不切，无影响 |
| **P3** 读接口 | documents 列表、conversations 列表/详情、metrics summary | 与 TS 版返回逐字段一致（拿同一 token 对比） | 从白名单删掉 |
| **P4** 写接口 | conversations 建/改、messages | 同上 | 同上 |
| **P5** RAG 核心 | search → chat（SSE + 缓存 + 拒答 + 指标） | 跑 `node eval/run.mjs`，与基线对比：答出率/引用率/拒答率**不下降** | 同上 |
| **P6** 文档写入 | upload、分片上传 3 条、原文预览 | 传一个 >10MB 的 PDF，断网重试后能续传成功；预览正常 | 同上 |
| **P7** 后台任务 | jobs/tick（解析/分块/向量化 + 重试 + 死信） | 上传后能走到 ready；人为断网触发重试与死信 | 同上 |
| **P8** 收尾 | telemetry、CI、删掉已迁移的 TS 路由 | CI 绿；`git grep` 确认旧实现已删 | — |

**P5 是分水岭**：过了这步，说明你的 RAG 链路在 Python 侧是等价的。
在这个阶段之前，别急着动任何有状态的东西。

---

## 5. 前端如何配合（不改前端代码）

Nuxt 那 23 个路由**原地保留**，加一层白名单转发：

```ts
// 伪代码：已经迁移到 Python 的路由，转发过去；其余照旧
const PY_ROUTES = new Set(['/api/health', '/api/documents', '/api/search', ...])
if (PY_ROUTES.has(path)) return proxyToPython(event)
```

- 转发时**透传 `Authorization` 头**和 query/body
- SSE 要透传流，不能缓冲（Nitro 可用 `sendProxy`）
- 回退 = 从 `PY_ROUTES` 里删掉一条，立刻回到 TS 实现

这样前端一行都不用改，迁移期间服务一直可用，也给了你逐条对比的机会。

---

## 6. 代码风格：别做成翻译版

这是"后端语言经验"能不能立住的关键。同一份功能，写法决定观感。

| 别这样（翻译版） | 要这样（Python 味） |
| --- | --- |
| 手动 `if not isinstance(...)` 校验入参 | Pydantic v2 的 `BaseModel` |
| 到处 `dict` 传参 | 显式 schema + type hints |
| 同步 `requests` / `psycopg2` | `httpx.AsyncClient` / `asyncpg` |
| 在 async 函数里调阻塞 IO | 全链路 await |
| 手写 SQL 字符串拼接 | SQLAlchemy `text()` + 绑定参数 |
| 没有测试 | pytest 覆盖 chunk / cache key / RRF / 限流 |

工具链：`ruff`（lint + format）、`mypy`（类型检查）。这两个进了 CI，
就没人能说这是"翻译过来的代码"。

---

## 7. Alembic 与测试

**Alembic**：现有 6 个 SQL 已经在你库里了，**不要重新执行**。
做法是建一个 baseline revision 表示"当前 schema"，然后 `alembic stamp head`，
之后的新变更才走 Alembic。这样迁移历史从第一天就是干净的。

**测试**：评测集（`eval/run.mjs`）打的是 HTTP，不用改，直接复用。
额外补 pytest 覆盖那些"逻辑复杂但没有测试"的地方——分块算法、缓存键、
RRF 融合、令牌桶，这几个是最该有单测的。

---

## 8. 风险清单

| 风险 | 后果 | 应对 |
| --- | --- | --- |
| 用所有者角色连接 → RLS 静默失效 | **数据串号，且无报错** | 两个角色 + FORCE RLS + P1 阶段的专项验证 |
| 忘记 `SET LOCAL` | 查不到数据（fail-closed） | 封装进 `get_db` 依赖，不给漏掉的机会 |
| 请求中间 commit 导致上下文失效 | 后续查询脱离 RLS | 每请求一个事务，流式前释放 |
| asyncpg + 事务模式池化器 | prepared statement 冲突报错 | 用直连，或 `statement_cache_size=0` |
| JWKS 拉取失败 | 所有请求 401 | 缓存公钥，失败时用缓存兜底 |
| 前后端类型不再共享 | 字段对不上，且编译期发现不了 | P3/P4 阶段拿同一 token 逐字段对比 |

---

## 9. 18:30 第一步（P0）

今晚只做三件事，别往下跳：

1. **建目录骨架**：`api/` 下按第 2 节的层级建立空模块，`main.py` 里只有
   一个 `GET /health`，返回配置项是否存在（照抄现在 `/api/health` 的口径，别回显密钥）。
2. **连上数据库**：`db.py` 里建一个 asyncpg engine，写一条最小查询
   （比如 `select count(*) from documents`），确认能连上 Supabase 直连地址。
3. **跑通一次**：`uvicorn api.main:app --reload`，浏览器或 curl 打开 `/health`，
   看到配置状态和数据库连通性就算 P0 完成。

**P0 的完成标准**：一条命令能起来，一个请求能打通，数据库能读到数据。
今晚到这里就收工，P1（隔离）是最需要清醒头脑的一步，留到下次。
