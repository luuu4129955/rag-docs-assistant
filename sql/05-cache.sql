-- ============================================================
-- 第五步优化：缓存与成本
-- 在 Supabase SQL Editor 里执行，可重复执行。
--
-- 两种缓存解决的是两笔不同的账：
--   1) embedding 缓存：同一段文本不重复调用向量化接口（省调用次数、省延迟）
--   2) 答案缓存：同一个问题、同一份语料、同一套参数 → 直接复用上次的答案
--      （省掉检索 + 重排 + 模型三笔开销）
-- ============================================================

-- 1) 向量缓存：只存「文本哈希 + 向量」，不存原文，所以可以全局共用
create table if not exists embedding_cache (
  key text primary key,          -- sha256(模型 + 文本)
  model text not null,
  embedding jsonb not null,      -- 存 JSON 数组而不是 vector 类型：读写都更直接
  created_at timestamptz not null default now()
);

-- 开 RLS 但不建策略：只有服务端（service key）能碰，普通用户读不到
alter table embedding_cache enable row level security;

-- 2) 答案缓存：答案属于某个用户，必须按人隔离
create table if not exists answer_cache (
  key text primary key,          -- sha256(用户 + 模型 + 阈值 + 语料版本 + 规范化问题)
  user_id uuid not null,
  question text not null,
  answer text not null,
  sources jsonb,
  used_count int,
  threshold real,
  model text,
  corpus_version text,
  hits int not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz
);

create index if not exists answer_cache_user_idx on answer_cache (user_id, created_at desc);

alter table answer_cache enable row level security;

drop policy if exists answer_cache_owner on answer_cache;
create policy answer_cache_owner on answer_cache
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 3) 指标表补一列：这一轮是不是命中缓存
alter table chat_metrics add column if not exists cached boolean not null default false;
