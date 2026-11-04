-- Answers are kept per site (naukri, LinkedIn), and `key` is now the
-- extension's storage key including its site prefix: 'q::<question>' for
-- naukri, 'li::<question>' for LinkedIn. The same question can have a
-- different answer on each site.
--
-- Rows written before this change have no prefix. They are dropped: every
-- browser re-uploads its answers once in the new format (CloudSync.KEY_FORMAT),
-- and the browser's copy is the source of truth.

delete from public.answers where key !~ '^[a-z]+::';

alter table public.answers
  add constraint answers_key_has_site check (key ~ '^[a-z]+::');

-- Same as before, except keys without a site prefix are ignored rather than
-- stored, so an extension that predates sites cannot write unlabeled rows.
create or replace function public.sync_answers(changes jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid      uuid := auth.uid();
  applied  integer;
  existing integer;
begin
  if uid is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;

  if jsonb_typeof(changes) is distinct from 'array' or jsonb_array_length(changes) > 500 then
    raise exception 'changes must be an array of at most 500 items' using errcode = '22023';
  end if;

  select count(*) into existing from public.answers where user_id = uid;
  if existing + jsonb_array_length(changes) > 10000 then
    raise exception 'Answer limit reached' using errcode = '54000';
  end if;

  with incoming as (
    -- One change per key: a batch may repeat a key; keep the newest.
    select distinct on (c->>'key')
           c->>'key'                                    as key,
           case when coalesce((c->>'deleted')::boolean, false) then null else c->'record' end as record,
           coalesce((c->>'deleted')::boolean, false)    as deleted,
           coalesce((c->>'last_used')::bigint, 0)       as last_used
      from jsonb_array_elements(changes) as c
     where jsonb_typeof(c) = 'object'
     order by c->>'key', coalesce((c->>'last_used')::bigint, 0) desc
  ),
  valid as (
    select *
      from incoming
     where key is not null
       and char_length(key) between 1 and 1000
       and key ~ '^[a-z]+::'   -- site prefix: 'q::' naukri, 'li::' LinkedIn
       and (deleted or (jsonb_typeof(record) = 'object' and pg_column_size(record) <= 65536))
  ),
  written as (
    insert into public.answers as a (user_id, key, record, deleted, last_used, updated_at)
    select uid, v.key, v.record, v.deleted, v.last_used, now()
      from valid as v
    on conflict (user_id, key) do update
       set record     = excluded.record,
           deleted    = excluded.deleted,
           last_used  = excluded.last_used,
           updated_at = now()
     where excluded.last_used > a.last_used
    returning 1
  )
  select count(*) into applied from written;

  return applied;
end;
$$;

revoke all on function public.sync_answers(jsonb) from public, anon;
grant execute on function public.sync_answers(jsonb) to authenticated;
