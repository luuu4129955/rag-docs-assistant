-- ============================================================
-- 第一步优化：鉴权与数据隔离
-- 在 Supabase 控制台 → SQL Editor 里整段执行，可重复执行。
--
-- 设计要点：
-- 1) 只在两张「根表」上加 user_id（conversations / documents），
--    messages 和 chunks 通过外键继承归属——这样不会出现
--    「消息属于 A、会话属于 B」这种自相矛盾的数据。
-- 2) RLS 策略里用 EXISTS 沿着外键回到根表比对 auth.uid()。
-- 3) 先建策略再回填历史数据：老数据 user_id 为空，谁登录都看不见，
--    需要时用文件末尾那段把老数据认领给某个账号。
-- ============================================================

-- ---------- 1. 根表加归属字段 ----------
alter table conversations add column if not exists user_id uuid;
alter table documents     add column if not exists user_id uuid;

create index if not exists conversations_user_idx on conversations (user_id, created_at desc);
create index if not exists documents_user_idx     on documents (user_id, created_at desc);

-- ---------- 2. 打开行级安全 ----------
alter table conversations enable row level security;
alter table documents     enable row level security;
alter table messages      enable row level security;
alter table chunks        enable row level security;

-- ---------- 3. 策略：只看得见自己的 ----------
-- conversations：本人拥有
drop policy if exists conv_owner on conversations;
create policy conv_owner on conversations
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- documents：本人拥有
drop policy if exists doc_owner on documents;
create policy doc_owner on documents
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- messages：归属跟随它所属的会话
drop policy if exists msg_owner on messages;
create policy msg_owner on messages
  for all
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = auth.uid()
    )
  );

-- chunks：归属跟随它所属的文档
drop policy if exists chunk_owner on chunks;
create policy chunk_owner on chunks
  for all
  using (
    exists (
      select 1 from documents d
      where d.id = chunks.document_id and d.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from documents d
      where d.id = chunks.document_id and d.user_id = auth.uid()
    )
  );

-- ---------- 4. 检索函数也要认人 ----------
-- 两层保护：
--   1) security invoker + RLS：数据库层面把关；
--   2) 显式传 owner：即使 RLS 没生效（比如用 service key 调用），也不会跨用户召回。
create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 5,
  owner uuid default null
)
returns table (id bigint, document_id uuid, filename text, idx int, content text, similarity float)
language sql
stable
security invoker
set search_path = public
as $$
  select c.id, c.document_id, d.filename, c.idx, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  join documents d on d.id = c.document_id
  where c.embedding is not null
    and (owner is null or d.user_id = owner)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------- 5. 把历史数据认领给一个账号（可选） ----------
-- 先注册/登录一次，去 Authentication → Users 复制自己的 UID，替换下面两处，
-- 再执行这段；执行后你之前上传的文档和会话才会重新出现在界面里。
--
-- update conversations set user_id = '你的-uid' where user_id is null;
-- update documents     set user_id = '你的-uid' where user_id is null;
