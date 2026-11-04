-- Cloud sync for saved answers.
--
-- One row per (user, question). The extension keeps its own copy in
-- chrome.storage.local and syncs with this table:
--   * pull:  GET /rest/v1/answers?updated_at=gt.<cursor>   (RLS: own rows only)
--   * push:  POST /rest/v1/rpc/sync_answers                (the only write path)
--
-- Conflicts are last-write-wins on `last_used` (the record's lastUsed, a
-- client epoch-ms timestamp), the same rule the extension's Import uses.
-- Deletions are kept as tombstones (deleted = true, record = null) so a
-- question deleted on one computer is not resurrected by another.

create table public.answers (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  key        text        not null check (char_length(key) between 1 and 1000),
  record     jsonb,
  deleted    boolean     not null default false,
  last_used  bigint      not null default 0,
  -- Server clock, set on every write: the pull cursor. Never trust the client's.
  updated_at timestamptz not null default now(),
  primary key (user_id, key),
  check (deleted or record is not null)
);

create index answers_user_updated_idx on public.answers (user_id, updated_at);

alter table public.answers enable row level security;

-- Reads: your own rows only. There are deliberately no insert/update/delete
-- policies, so clients cannot write the table directly — only through the
-- functions below, which enforce the conflict rule and the limits.
create policy "Users read their own answers"
  on public.answers for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- sync_answers(changes): apply a batch of client changes.
--
-- changes: [{ "key": text, "record": jsonb|null, "deleted": bool, "last_used": int8 }]
-- A change is applied only when its last_used is newer than the stored one.
-- Returns how many rows were written.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- delete_account(): remove the caller and, via the cascade, every answer.
-- ---------------------------------------------------------------------------
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in' using errcode = '28000';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
