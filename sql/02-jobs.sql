-- ============================================================
-- 第二步优化：把上传与向量化转成后台任务
-- 在 Supabase SQL Editor 里执行，可重复执行。
--
-- 为什么要加状态字段：处理从「一次请求内做完」变成「后台多轮完成」，
-- 就必须有个地方记录每份文档走到哪一步了——这是异步化的前提。
--   pending   已上传，等待解析
--   embedding 解析与分块完成，等待向量化
--   ready     全部完成
--   failed    失败，error 字段里是原因
-- ============================================================

alter table documents add column if not exists status text not null default 'pending';
alter table documents add column if not exists error text;
alter table documents add column if not exists updated_at timestamptz;

create index if not exists documents_status_idx on documents (status, created_at);

-- 已存在的老文档：分块都已向量化的直接标成就绪，避免被后台重复处理
update documents d
set status = 'ready',
    updated_at = now()
where d.status = 'pending'
  and exists (select 1 from chunks c where c.document_id = d.id)
  and not exists (select 1 from chunks c where c.document_id = d.id and c.embedding is null);
