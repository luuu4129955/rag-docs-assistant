-- ============================================================
-- 第四步优化：混合检索（关键词那一路）
-- 在 Supabase SQL Editor 里执行，可重复执行。
--
-- 为什么不用 Postgres 内置全文检索：它是按空格分词的，而中文没有空格，
-- 一整句话会被当成一个词（除非装 zhparser / pg_jieba 这类扩展，Supabase 默认没有）。
--
-- 所以这里用朴素但有效的做法：把查询按空格和标点切开，逐个做 ILIKE 匹配，
-- 命中的词越多分越高。它不懂词形变化，但对「型号、编号、专有名词」这类
-- 字面精确匹配特别管用——正好补上向量检索的短板（向量会把 HNSW 和 HNSW 索引
-- 当成差不多的东西，关键词不会）。
-- ============================================================

create or replace function search_chunks_keyword(
  p_query text,
  p_limit int default 20,
  p_owner uuid default null
)
returns table (id bigint, document_id uuid, filename text, idx int, content text, hits int)
language sql
stable
security invoker
set search_path = public
as $$
  with terms as (
    select distinct term
    from unnest(
      regexp_split_to_array(
        lower(coalesce(p_query, '')),
        '[\s,，。、；;：:！!？?（）()【】{}·—]+'
      )
    ) as term
    where length(term) >= 2
  )
  select
    c.id,
    c.document_id,
    d.filename,
    c.idx,
    c.content,
    (select count(*)::int from terms t where c.content ilike '%' || t.term || '%') as hits
  from chunks c
  join documents d on d.id = c.document_id
  where c.embedding is not null
    and (p_owner is null or d.user_id = p_owner)
    and exists (select 1 from terms t where c.content ilike '%' || t.term || '%')
  order by hits desc, c.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;
