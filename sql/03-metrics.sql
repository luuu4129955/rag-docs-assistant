-- ============================================================
-- 第三步优化：可观测 —— 把关键指标落到库里
-- 在 Supabase SQL Editor 里执行，可重复执行。
--
-- 为什么落库而不是只打日志：日志适合排查单次故障，指标需要能聚合——
-- 「这周拒答率是多少」「P95 延迟有没有变差」这类问题，日志答不上来。
-- ============================================================

create table if not exists chat_metrics (
  id bigint generated always as identity primary key,
  user_id uuid,
  conversation_id uuid,
  model text,
  retrieval_ms int,          -- 检索耗时
  first_token_ms int,        -- 首字延迟
  total_ms int,              -- 整轮耗时
  prompt_tokens int,         -- 输入 token
  completion_tokens int,     -- 输出 token
  retrieved_count int,       -- 召回几块
  used_count int,            -- 几块过了阈值
  refused boolean not null default false,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists chat_metrics_created_idx on chat_metrics (created_at desc);
create index if not exists chat_metrics_user_idx on chat_metrics (user_id, created_at desc);

alter table chat_metrics enable row level security;

-- 只允许读自己的指标；写入由服务端（管理端客户端）完成
drop policy if exists metrics_owner on chat_metrics;
create policy metrics_owner on chat_metrics
  for select
  using (user_id = auth.uid());
