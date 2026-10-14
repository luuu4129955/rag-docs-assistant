-- ============================================================
-- 第六步优化：限流 + 任务重试/死信 + 前端错误监控 + 分片上传
-- 在 Supabase SQL Editor 里执行，可重复执行。
--
-- 这一批解决的是「上线之后才会遇到的那类问题」：
--   1) 有人疯狂点提问 / 脚本刷接口 → 令牌桶限流
--   2) 向量化接口偶发超时 → 任务失败自动重试，重试到头进死信并告警
--   3) 前端报错只能靠用户截图 → 浏览器异常自动上报落库
--   4) 大文件撞上 Serverless 请求体上限 → 分片上传 + 断点续传
-- ============================================================

-- ---------- 1. 令牌桶限流 ----------
-- 按「动作 + 用户」记一个桶。放在数据库而不是进程内存里，是因为
-- Serverless 每次请求可能落到不同实例，内存计数器各算各的，等于没限。
create table if not exists rate_limits (
  bucket_key text primary key,          -- 例如 "chat:<userId>" / "telemetry:<ip>"
  tokens     real not null,             -- 桶里当前还剩多少令牌
  updated_at timestamptz not null default now()
);

-- 开 RLS 但不建策略：只有服务端（service key）能碰
alter table rate_limits enable row level security;

-- 原子取令牌：读-改-写放进一个加锁的循环里，并发请求不会各读到旧值再各扣一次。
--   p_capacity        桶容量（= 允许的瞬时突发）
--   p_refill_per_sec  每秒回填多少令牌（= 长期平均速率）
--   p_cost            本次要花几个令牌
create or replace function take_token(
  p_key text,
  p_capacity real,
  p_refill_per_sec real,
  p_cost real default 1
)
returns table (allowed boolean, remaining real, retry_after_ms int)
language plpgsql
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row rate_limits%rowtype;
  v_tokens real;
  v_elapsed real;
begin
  if p_capacity <= 0 then
    return query select true, 0::real, 0;
    return;
  end if;

  -- 没有桶就建一个满桶；并发下插入可能撞主键，撞了就回到循环顶部重新加锁读
  loop
    select * into v_row from rate_limits where bucket_key = p_key for update;
    exit when found;
    begin
      insert into rate_limits (bucket_key, tokens, updated_at)
      values (p_key, p_capacity, v_now)
      returning * into v_row;
      exit;
    exception when unique_violation then
      -- 另一个并发请求刚好插入成功，重新读一次
    end;
  end loop;

  v_elapsed := greatest(0, extract(epoch from (v_now - v_row.updated_at)));
  v_tokens := least(p_capacity, v_row.tokens + v_elapsed * p_refill_per_sec);

  if v_tokens >= p_cost then
    update rate_limits set tokens = v_tokens - p_cost, updated_at = v_now
    where bucket_key = p_key;
    return query select true, (v_tokens - p_cost), 0;
    -- 关键：RETURN QUERY 只是「往结果集里追加一行」，**不会结束函数**。
    -- 少了下面这句 return，代码会继续往下执行，函数就返回两行
    --（一行允许、一行拒绝），调用方拿 .one() 会直接报错，
    -- 而且桶被第二次更新覆盖，令牌等于没扣 —— 限流静默失效。
    return;
  end if;

  update rate_limits set tokens = v_tokens, updated_at = v_now
  where bucket_key = p_key;
  return query select false, v_tokens,
    greatest(0, ceil(((p_cost - v_tokens) / greatest(p_refill_per_sec, 0.0001)) * 1000)::int);
  return;
end;
$$;

-- ---------- 2. 任务失败重试与死信 ----------
-- attempts        已经试过几次
-- next_retry_at   下次可以重试的时间（退避：30s → 60s → 120s）
-- dead_lettered_at 超过最大次数后被放弃的时间；非空 = 死信
alter table documents add column if not exists attempts int not null default 0;
alter table documents add column if not exists next_retry_at timestamptz;
alter table documents add column if not exists dead_lettered_at timestamptz;

create index if not exists documents_retry_idx on documents (status, next_retry_at);

-- ---------- 3. 前端错误监控 ----------
-- 浏览器里的异常（JS 报错 / 未处理的 Promise / 接口 5xx / Vue 渲染错误）
-- 统一上报到这里，配上面板就是一个轻量版 Sentry。
create table if not exists client_errors (
  id bigint generated always as identity primary key,
  user_id uuid,
  kind text,                 -- js / promise / vue / request / resource
  message text,
  source text,
  stack text,
  url text,
  user_agent text,
  meta jsonb,
  created_at timestamptz not null default now()
);

create index if not exists client_errors_created_idx on client_errors (created_at desc);
create index if not exists client_errors_user_idx on client_errors (user_id, created_at desc);

alter table client_errors enable row level security;

-- 只允许读自己的错误；写入由服务端完成
drop policy if exists client_errors_owner on client_errors;
create policy client_errors_owner on client_errors
  for select
  using (user_id = auth.uid());

-- ---------- 4. 分片上传会话 ----------
-- 一次上传对应一条会话，记录「传了哪些分片」，刷新页面后据此续传。
-- 分片本身存在 Storage 的 {user}/uploads/{uploadId}/part-N 下，完成后合并、清理。
create table if not exists upload_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  filename text not null,
  size_bytes bigint not null,
  fingerprint text not null,          -- 文件名+大小+修改时间，用来认领未完成的上传
  chunk_size int not null,
  total_parts int not null,
  status text not null default 'open', -- open / done / aborted
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists upload_sessions_fp_idx
  on upload_sessions (user_id, fingerprint, status);

alter table upload_sessions enable row level security;

drop policy if exists upload_sessions_owner on upload_sessions;
create policy upload_sessions_owner on upload_sessions
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
