-- ============================================================
-- 第七步：让「直连 Postgres」这条新路径也能受 RLS 保护
-- 在 Supabase 控制台 → SQL Editor 里整段执行，可重复执行。
--
-- 背景：现在 RLS 之所以生效，是因为 PostgREST 用请求里的 token 决定数据库角色；
-- 换成 asyncpg 直连之后，这个机制不存在了，必须自己把身份放进会话上下文。
--
-- 这一步要让**新旧两个后端能同时工作**（迁移期必须如此）：
--   · Python 直连：每个事务里 SET LOCAL app.user_id = <uuid>
--   · TS/PostgREST：Supabase 仍然把 JWT 放进 request.jwt.claims
-- 所以身份解析写成一个「优先用会话变量、回退到 JWT」的函数。
-- ============================================================


-- ---------- 0. 前置检查 ----------
-- 这个脚本要给 8 张表改写策略，缺哪张都不行。
-- 与其抛一句难懂的 `42P01: relation "client_errors" does not exist`，
-- 不如直接把缺的表名和该先跑哪个脚本说清楚。
--
-- 正确顺序：sql/01 → 02 → 03 → 04 → 05 → 06，全部跑完再跑本脚本。
do $$
declare
  needed text[] := array[
    'conversations', 'documents', 'messages', 'chunks',   -- sql/01
    'chat_metrics',                                        -- sql/03
    'answer_cache',                                        -- sql/05
    'client_errors', 'upload_sessions'                     -- sql/06
  ];
  missing text[] := '{}';
  t text;
begin
  foreach t in array needed
  loop
    if to_regclass('public.' || t) is null then
      missing := missing || t;
    end if;
  end loop;

  if array_length(missing, 1) > 0 then
    raise exception
      '缺少这些表：%。请先按顺序执行 sql/01 → 06，再运行本脚本。',
      array_to_string(missing, ', ')
      using hint = '最常见的是漏了 sql/06-limits-jobs.sql —— 它建 client_errors / upload_sessions / rate_limits。';
  end if;
end
$$;


-- ---------- 1. 统一的「当前用户」函数 ----------
-- 为什么要多这一层：策略里如果到处写 auth.uid()，将来换实现要改十几处；
-- 收敛成一个函数之后，只需要改这一个地方。
--
-- 三段式解析，任何一段解析失败都返回 NULL —— 也就是 fail-closed：
-- 拿不到身份的查询会「查不到数据」，而不是「查到别人的数据」。
create or replace function app_current_user() returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v text;
begin
  -- 1) Python/asyncpg 直连：事务里 SET LOCAL app.user_id
  v := nullif(current_setting('app.user_id', true), '');
  if v is not null then
    return v::uuid;
  end if;

  -- 2) PostgREST（现有 TS 后端）：Supabase 解析好的 sub
  v := nullif(current_setting('request.jwt.claim.sub', true), '');
  if v is not null then
    return v::uuid;
  end if;

  -- 3) 有些版本只提供整个 claims JSON
  v := nullif(current_setting('request.jwt.claims', true), '');
  if v is not null then
    return (v::jsonb ->> 'sub')::uuid;
  end if;

  return null;
exception
  when others then
    return null;
end;
$$;


-- ---------- 2. 把 8 条策略里的 auth.uid() 换成 app_current_user() ----------
-- 注意策略名保持不变，这样 postgres 或其它角色上的既有授权不受影响。

drop policy if exists conv_owner on conversations;
create policy conv_owner on conversations
  for all
  using (user_id = app_current_user())
  with check (user_id = app_current_user());

drop policy if exists doc_owner on documents;
create policy doc_owner on documents
  for all
  using (user_id = app_current_user())
  with check (user_id = app_current_user());

drop policy if exists msg_owner on messages;
create policy msg_owner on messages
  for all
  using (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = app_current_user()
    )
  )
  with check (
    exists (
      select 1 from conversations c
      where c.id = messages.conversation_id and c.user_id = app_current_user()
    )
  );

drop policy if exists chunk_owner on chunks;
create policy chunk_owner on chunks
  for all
  using (
    exists (
      select 1 from documents d
      where d.id = chunks.document_id and d.user_id = app_current_user()
    )
  )
  with check (
    exists (
      select 1 from documents d
      where d.id = chunks.document_id and d.user_id = app_current_user()
    )
  );

drop policy if exists metrics_owner on chat_metrics;
create policy metrics_owner on chat_metrics
  for select
  using (user_id = app_current_user());

drop policy if exists answer_cache_owner on answer_cache;
create policy answer_cache_owner on answer_cache
  for all
  using (user_id = app_current_user())
  with check (user_id = app_current_user());

drop policy if exists client_errors_owner on client_errors;
create policy client_errors_owner on client_errors
  for select
  using (user_id = app_current_user());

drop policy if exists upload_sessions_owner on upload_sessions;
create policy upload_sessions_owner on upload_sessions
  for all
  using (user_id = app_current_user())
  with check (user_id = app_current_user());


-- ---------- 3. 建两个应用角色（P1 的关键一步） ----------
-- **为什么必须建角色**：PostgreSQL 里表的所有者默认绕过 RLS。
-- 直连时如果用 postgres（所有者）连接，隔离会静默失效 ——
-- 查询照常返回，但跨用户数据全都能看到，而且不会有任何报错。
--
-- 所以：
--   app_rls    非所有者 → RLS 生效，给所有面向用户的请求用
--   app_admin  带 BYPASSRLS → 给后台任务/定时任务/指标写入用
--
-- 执行完请把两个口令改成你自己的，并把连接串写进 .env 的
-- NUXT_SUPABASE_DB_URL / NUXT_SUPABASE_DB_ADMIN_URL。
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_rls') then
    create role app_rls login password 'CHANGE_ME_APP_RLS';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_admin') then
    create role app_admin login bypassrls password 'CHANGE_ME_APP_ADMIN';
  end if;
end
$$;

grant usage on schema public to app_rls, app_admin;
grant select, insert, update, delete on all tables in schema public to app_rls;
grant all on all tables in schema public to app_admin;
grant usage, select on all sequences in schema public to app_rls, app_admin;
grant execute on all functions in schema public to app_rls, app_admin;

-- 将来新建的表/序列也自动授权，免得每加一张表就漏一次
alter default privileges in schema public
  grant select, insert, update, delete on tables to app_rls;
alter default privileges in schema public
  grant all on tables to app_admin;
alter default privileges in schema public
  grant usage, select on sequences to app_rls, app_admin;


-- ---------- 4. 可选：如果你不方便用独立角色 ----------
-- 另一种做法是强制所有者也受策略约束。**代价**：Supabase 控制台的 SQL Editor
-- 通常以 postgres 身份执行，开了 FORCE 之后你在编辑器里查表也会被策略过滤，
-- 排查问题时容易自己把自己绕进去。所以默认注释掉，确认过再开。
--
-- alter table conversations   force row level security;
-- alter table documents       force row level security;
-- alter table messages        force row level security;
-- alter table chunks          force row level security;
-- alter table chat_metrics    force row level security;
-- alter table answer_cache    force row level security;
-- alter table client_errors   force row level security;
-- alter table upload_sessions force row level security;


-- ---------- 5. P1 完成后必须做的验证 ----------
-- 别只看「代码能跑」，要确认隔离真的生效。用 app_rls 的连接跑下面两段：
--
--   -- a) 不设身份：应当返回 0 行（fail-closed）
--   select count(*) from documents;
--
--   -- b) 设成某个真实用户：应当只看到他的数据
--   begin;
--     select set_config('app.user_id', '<某个用户的 uid>', true);
--     select count(*) from documents;
--   rollback;
--
-- 如果 a) 返回的是全部数据，说明你连的角色是所有者 —— 隔离没生效，必须换角色。
