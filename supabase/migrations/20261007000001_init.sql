-- agency-board MVP-a init. Source of truth: docs/CONTRACT.md section 3.
-- Every table: RLS on, zero policies. Only service_role can touch anything.

create extension if not exists vector with schema extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Pure helpers (needed by table definitions)
-- ---------------------------------------------------------------------------

create or replace function public.hub_unaccent(text) returns text
language sql immutable strict parallel safe
set search_path = public, extensions
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

create or replace function public.hub_ns_match(ns text, patterns text[]) returns bool
language sql immutable parallel safe
set search_path = public, extensions
as $$
  select coalesce(bool_or(
           p = '*'
        or ns = p
        or (right(p, 2) = '/*' and (ns = left(p, -2) or starts_with(ns, left(p, -2) || '/')))
         ), false)
  from unnest(patterns) as p
$$;

-- array_to_string is only STABLE, so the generated column goes through this IMMUTABLE wrapper.
create or replace function public.hub_fts_doc(slug text, content text, tags text[]) returns tsvector
language sql immutable parallel safe
set search_path = public, extensions
as $$
  select to_tsvector('simple', public.hub_unaccent(
    coalesce(slug,'') || ' ' || coalesce(content,'') || ' ' || coalesce(array_to_string(tags, ' '), '')))
$$;

create or replace function public.hub_luhn(d text) returns bool
language plpgsql immutable parallel safe
set search_path = public, extensions
as $$
declare
  digits text := regexp_replace(coalesce(d, ''), '\D', '', 'g');
  s int := 0;
  x int;
  alt bool := false;
begin
  if length(digits) = 0 then return false; end if;
  for i in reverse length(digits)..1 loop
    x := substr(digits, i, 1)::int;
    if alt then
      x := x * 2;
      if x > 9 then x := x - 9; end if;
    end if;
    s := s + x;
    alt := not alt;
  end loop;
  return s % 10 = 0;
end $$;

-- Returns the first matching rule id ('card'|'account') or NULL if clean.
-- Rules mirror lib/guard.ts verbatim (CONTRACT section 3 table).
create or replace function public.hub_confidential_rule(t text) returns text
language plpgsql immutable parallel safe
set search_path = public, extensions
as $$
declare
  m text[];
begin
  if t is null then return null; end if;
  for m in select regexp_matches(t, '\m\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\M', 'g') loop
    if public.hub_luhn(m[1]) then return 'card'; end if;
  end loop;
  if t ~* '(stk|s[oố] t[aà]i kho[aả]n|account (no|number|#))\D{0,5}\d{6,}' then return 'account'; end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.devices (
  id uuid primary key default gen_random_uuid(),
  machine_name text not null unique,
  os text check (os in ('mac','windows','linux')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table public.agent_tokens (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent ~ '^[a-z][a-z0-9]{1,23}$'),
  device_id uuid references public.devices(id),
  token_hash text not null unique,
  token_prefix text not null,
  read_ns text[] not null,
  write_ns text[] not null,
  inbox_only bool not null default false,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_heartbeat_at timestamptz,
  model text,
  status_note text,
  current_task_id uuid,
  revoked_at timestamptz
);
create index agent_tokens_device_idx on public.agent_tokens (device_id);

create table public.connect_codes (
  code_hash text primary key,
  machine_name text not null,
  os text,
  agents text[] not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_ip inet,
  device_id uuid references public.devices(id)
);

create table public.memories (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  slug text not null,
  content text not null check (length(content) <= 8192),
  tags text[] not null default '{}',
  author_agent text not null,
  author_device text,
  author_token uuid,
  target_namespace text,
  review_status text check (review_status in ('pending','approved','rejected')),
  approved_by text,
  pinned bool not null default false,
  flags text[] not null default '{}',
  embedding extensions.vector(384),
  embed_model text,
  fts tsvector generated always as (public.hub_fts_doc(slug, content, tags)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  deleted_at timestamptz,
  unique (namespace, slug),
  check (namespace ~ '^[a-z0-9-]+(/[a-z0-9-]+)*$'),
  check (length(namespace) <= 100)
);
create index memories_embedding_hnsw on public.memories using hnsw (embedding extensions.vector_cosine_ops);
create index memories_fts_gin on public.memories using gin (fts);
create index memories_tags_gin on public.memories using gin (tags);
create index memories_ns_created_idx on public.memories (namespace, created_at desc);

create table public.memory_links (
  id bigserial primary key,
  from_id uuid not null references public.memories(id) on delete cascade,
  to_id uuid references public.memories(id) on delete cascade,
  to_slug text,
  to_namespace text,
  relation text not null check (relation in ('relates_to','supersedes','part_of','about_project')),
  created_by text not null,
  auto bool not null default false,
  score real,
  created_at timestamptz not null default now(),
  check (to_id is not null or to_slug is not null)
);
create unique index memory_links_uniq on public.memory_links
  (from_id, relation, coalesce(to_id::text, coalesce(to_namespace,'') || ':' || to_slug));
create index memory_links_to_idx on public.memory_links (to_id, relation);
create index memory_links_dangling_idx on public.memory_links (to_slug) where to_id is null;

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  namespace text not null,
  title text not null check (length(title) <= 200),
  body text check (length(body) <= 4096),
  status text not null default 'open' check (status in ('open','claimed','done','failed','cancelled')),
  created_by text not null,
  created_by_token uuid,
  claimed_by_token uuid,
  claimed_by_agent text,
  lease_expires_at timestamptz,
  attempts int not null default 0,
  handoff_to text,
  result jsonb,
  completion_key text,
  routed_by text,
  routing_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  check (namespace ~ '^[a-z0-9-]+(/[a-z0-9-]+)*$'),
  check (length(namespace) <= 100)
);
create index tasks_status_ns_idx on public.tasks (status, namespace);
create index tasks_handoff_open_idx on public.tasks (handoff_to) where status = 'open';

create table public.task_events (
  id bigserial primary key,
  task_id uuid references public.tasks(id) on delete cascade,
  actor text not null,
  kind text not null check (kind in ('created','claimed','renewed','handoff','update','done','failed','released','cancelled','retried')),
  note text,
  at timestamptz not null default now()
);
create index task_events_task_idx on public.task_events (task_id, at);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id),
  requested_by text not null,
  requested_by_token uuid,
  question text not null check (length(question) <= 2000),
  options jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending','approved','denied','expired')),
  answer text,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.system_flags (
  key text primary key check (key in ('dispatch_paused','writes_frozen')),
  value bool not null default false,
  set_at timestamptz
);
insert into public.system_flags (key, value) values ('dispatch_paused', false), ('writes_frozen', false)
on conflict (key) do nothing;

create table public.rate_limits (
  key text,
  window_start timestamptz,
  count int not null default 0,
  primary key (key, window_start)
);

create table public.access_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  token_id uuid,
  device_id uuid,
  agent text,
  ip inet,
  asn int,
  country char(2),
  city text,
  client text,
  route text not null,
  result smallint not null
);
create index access_log_token_at_idx on public.access_log (token_id, at desc);
create index access_log_at_idx on public.access_log (at);
create index access_log_authfail_idx on public.access_log (ip, at desc) where result in (401, 403);

create table public.device_known (
  device_id uuid references public.devices(id) on delete cascade,
  kind text check (kind in ('country','network')),
  value text not null,
  trusted_by text not null,
  at timestamptz not null default now(),
  primary key (device_id, kind, value)
);

create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  device_id uuid,
  token_id uuid,
  rule text not null check (rule in ('new_country','concurrent_use','auth_burst','new_network')),
  severity text not null check (severity in ('red','yellow')),
  value text not null,
  detail jsonb not null default '{}',
  status text not null default 'open' check (status in ('open','rotated','disabled','trusted','dismissed')),
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index alerts_open_uniq on public.alerts (coalesce(token_id::text, '-'), rule, value) where status = 'open';

-- ---------------------------------------------------------------------------
-- Confidential guard layer 2 (triggers). Message never echoes content.
-- ---------------------------------------------------------------------------

create or replace function public.hub_guard_memories() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_confidential_rule(new.namespace), hub_confidential_rule(new.slug), hub_confidential_rule(new.content),
                hub_confidential_rule(array_to_string(new.tags, ',')), hub_confidential_rule(new.target_namespace));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CONFIDENTIAL_BLOCKED:' || r;
  end if;
  return new;
end $$;

create or replace function public.hub_guard_tasks() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_confidential_rule(new.namespace), hub_confidential_rule(new.title), hub_confidential_rule(new.body),
                hub_confidential_rule(new.result::text), hub_confidential_rule(new.handoff_to));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CONFIDENTIAL_BLOCKED:' || r;
  end if;
  return new;
end $$;

create or replace function public.hub_guard_approvals() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_confidential_rule(new.question), hub_confidential_rule(new.options::text), hub_confidential_rule(new.answer));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CONFIDENTIAL_BLOCKED:' || r;
  end if;
  return new;
end $$;

create trigger memories_confidential_guard before insert or update of namespace, slug, content, tags, target_namespace
  on public.memories for each row execute function public.hub_guard_memories();
create trigger tasks_confidential_guard before insert or update of namespace, title, body, result, handoff_to
  on public.tasks for each row execute function public.hub_guard_tasks();
create trigger approvals_confidential_guard before insert or update of question, options, answer
  on public.approvals for each row execute function public.hub_guard_approvals();

-- ---------------------------------------------------------------------------
-- Visibility (CONTRACT section 2). Scope is checked separately via hub_ns_match.
-- A supersedes link only hides the old row while the superseding row is not deleted.
-- ---------------------------------------------------------------------------

create or replace function public.hub_visible(m public.memories, caller_agent text) returns bool
language sql stable
set search_path = public, extensions
as $$
  select m.deleted_at is null
     and (m.review_status is null or m.review_status = 'approved' or m.author_agent = caller_agent)
     and not exists (
       select 1 from public.memory_links l join public.memories n on n.id = l.from_id
       where l.to_id = m.id and l.relation = 'supersedes' and n.deleted_at is null)
$$;

-- ---------------------------------------------------------------------------
-- Search / graph
-- ---------------------------------------------------------------------------

create or replace function public.hub_search(
  q_embedding extensions.vector(384), q_text text, read_patterns text[], caller_agent text,
  ns_filter text default null, k int default 10, q_model text default 'gte-small')
returns table(id uuid, namespace text, slug text, content text, tags text[], author_agent text,
              author_device text, created_at timestamptz, updated_at timestamptz, flags text[],
              review_status text, pinned bool, score double precision)
language sql stable
set search_path = public, extensions
as $$
  with vis as (
    select m.* from public.memories m
    where hub_ns_match(m.namespace, read_patterns)
      and (ns_filter is null or hub_ns_match(m.namespace, array[ns_filter]))
      and hub_visible(m, caller_agent)
  ),
  vec as (
    select v.id, row_number() over (order by v.embedding <=> q_embedding) as r
    from vis v
    where q_embedding is not null and v.embedding is not null and v.embed_model = q_model
    order by v.embedding <=> q_embedding
    limit 50
  ),
  q as (
    select websearch_to_tsquery('simple', hub_unaccent(q_text)) as tsq
    where nullif(btrim(q_text), '') is not null
  ),
  txt as (
    select v.id, row_number() over (order by ts_rank(v.fts, q.tsq) desc) as r
    from vis v, q
    where v.fts @@ q.tsq
    order by ts_rank(v.fts, q.tsq) desc
    limit 50
  ),
  fused as (
    select u.id, sum(1.0 / (60 + u.r)) as s
    from (select * from vec union all select * from txt) u
    group by u.id
  )
  select m.id, m.namespace, m.slug, m.content, m.tags, m.author_agent, m.author_device,
         m.created_at, m.updated_at, m.flags, m.review_status, m.pinned,
         (f.s + case when m.pinned then 0.01 else 0 end)::double precision as score
  from fused f join public.memories m on m.id = f.id
  order by score desc, m.created_at desc
  limit greatest(k, 0)
$$;

-- Scope + visibility checked on every node before it is returned OR expanded,
-- so an unreadable node is a wall, not a bridge. Seeds must themselves be readable.
create or replace function public.hub_neighbors(
  seed_ids uuid[], read_patterns text[], caller_agent text, max_depth int default 1, max_nodes int default 50)
returns table(seed_id uuid, id uuid, depth int, relation text, direction text, auto bool, score real,
              namespace text, slug text, content text, author_agent text, author_device text,
              created_at timestamptz, flags text[])
language sql stable
set search_path = public, extensions
as $$
  with recursive
  edges as (
    select l.from_id as a, l.to_id as b, l.relation, 'out'::text as dir, l.auto, l.score
    from public.memory_links l where l.to_id is not null
    union all
    select l.to_id, l.from_id, l.relation, 'in'::text, l.auto, l.score
    from public.memory_links l where l.to_id is not null
  ),
  seeds as (
    select s.id from public.memories s
    where s.id = any(seed_ids) and hub_ns_match(s.namespace, read_patterns) and hub_visible(s, caller_agent)
  ),
  walk(seed_id, id, depth, relation, direction, auto, score, path) as (
    select sd.id, e.b, 1, e.relation, e.dir, e.auto, e.score, array[sd.id, e.b]
    from seeds sd
    join edges e on e.a = sd.id
    join public.memories m on m.id = e.b
    where hub_ns_match(m.namespace, read_patterns) and hub_visible(m, caller_agent)
    union all
    select w.seed_id, e.b, w.depth + 1, e.relation, e.dir, e.auto, e.score, w.path || e.b
    from walk w
    join edges e on e.a = w.id
    join public.memories m on m.id = e.b
    where w.depth < least(greatest(max_depth, 1), 2)
      and not (e.b = any(w.path))
      and hub_ns_match(m.namespace, read_patterns) and hub_visible(m, caller_agent)
  ),
  best as (
    select distinct on (w.seed_id, w.id) w.*
    from walk w
    where not (w.id = any(seed_ids))
    order by w.seed_id, w.id, w.depth, w.score desc nulls last
  )
  select b.seed_id, b.id, b.depth, b.relation, b.direction, b.auto, b.score,
         m.namespace, m.slug, m.content, m.author_agent, m.author_device, m.created_at, m.flags
  from best b join public.memories m on m.id = b.id
  order by b.depth, b.score desc nulls last, m.created_at desc
  limit greatest(max_nodes, 0)
$$;

-- Attach dangling links (to_id null) that point at this memory's slug.
create or replace function public.hub_resolve_links(p_id uuid) returns int
language plpgsql
set search_path = public, extensions
as $$
declare
  t public.memories;
  n int;
begin
  select * into t from public.memories where id = p_id;
  if not found then return 0; end if;

  -- drop candidates that would collide with the unique index once resolved
  delete from public.memory_links l
  where l.to_id is null and l.to_slug = t.slug and (l.to_namespace is null or l.to_namespace = t.namespace)
    and l.from_id <> p_id
    and (exists (select 1 from public.memory_links x
                 where x.from_id = l.from_id and x.relation = l.relation and x.to_id = p_id)
         or exists (select 1 from public.memory_links y
                    where y.to_id is null and y.to_slug = t.slug
                      and (y.to_namespace is null or y.to_namespace = t.namespace)
                      and y.from_id = l.from_id and y.relation = l.relation and y.id < l.id));

  update public.memory_links l set to_id = p_id
  where l.to_id is null and l.to_slug = t.slug and (l.to_namespace is null or l.to_namespace = t.namespace)
    and l.from_id <> p_id;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.hub_resolve_links_trg() returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  perform public.hub_resolve_links(new.id);
  return null;
end $$;

create trigger memories_resolve_links after insert on public.memories
  for each row execute function public.hub_resolve_links_trg();

create or replace function public.hub_autolink(p_id uuid, read_patterns text[], k int default 3, threshold real default 0.85)
returns int
language plpgsql
set search_path = public, extensions
as $$
declare n int;
begin
  insert into public.memory_links (from_id, to_id, relation, created_by, auto, score)
  select s.id, m.id, 'relates_to', 'auto', true, (1 - (m.embedding <=> s.embedding))::real
  from public.memories s
  join public.memories m on m.id <> s.id and m.embed_model = s.embed_model and m.embedding is not null
  where s.id = p_id and s.embedding is not null
    and hub_ns_match(m.namespace, read_patterns)
    and hub_visible(m, s.author_agent)
    and 1 - (m.embedding <=> s.embedding) >= threshold
  order by m.embedding <=> s.embedding
  limit greatest(k, 0)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Coordination
-- ---------------------------------------------------------------------------

create or replace function public.hub_claim(p_task uuid, p_token uuid, p_agent text, p_lease_seconds int default 600)
returns setof public.tasks
language sql
set search_path = public, extensions
as $$
  with c as (
    update public.tasks t set
      status = 'claimed',
      claimed_by_token = p_token,
      claimed_by_agent = p_agent,
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempts = t.attempts + 1,
      started_at = coalesce(t.started_at, now()),
      updated_at = now()
    where t.id = p_task
      and (t.status = 'open' or (t.status = 'claimed' and t.lease_expires_at < now()))
      and (t.handoff_to is null or t.handoff_to = p_agent)
    returning t.*
  ), e as (
    insert into public.task_events (task_id, actor, kind) select c.id, p_agent, 'claimed' from c
  )
  select * from c
$$;

create or replace function public.hub_renew(p_task uuid, p_token uuid, p_lease_seconds int default 600) returns bool
language plpgsql
set search_path = public, extensions
as $$
declare a text;
begin
  update public.tasks set lease_expires_at = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_task and status = 'claimed' and claimed_by_token = p_token
  returning claimed_by_agent into a;
  if not found then return false; end if;
  insert into public.task_events (task_id, actor, kind) values (p_task, coalesce(a, 'unknown'), 'renewed');
  return true;
end $$;

create or replace function public.hub_complete(p_task uuid, p_token uuid, p_key text, p_result jsonb, p_status text default 'done')
returns table(outcome text, task jsonb)
language plpgsql
set search_path = public, extensions
as $$
#variable_conflict use_column
declare t public.tasks;
begin
  if p_status not in ('done','failed') then
    raise exception using errcode = '22023', message = 'INVALID_STATUS';
  end if;

  select * into t from public.tasks where id = p_task for update;
  if not found then
    return query select 'not_claimer'::text, null::jsonb; return;
  end if;

  if t.status in ('done','failed') then
    if t.completion_key is not distinct from p_key then
      return query select 'replay'::text, to_jsonb(t);
    else
      return query select 'conflict'::text, null::jsonb;
    end if;
    return;
  end if;

  if t.status <> 'claimed' or t.claimed_by_token is distinct from p_token then
    return query select 'not_claimer'::text, null::jsonb; return;
  end if;

  update public.tasks set status = p_status, completion_key = p_key, result = p_result,
         completed_at = now(), lease_expires_at = null, updated_at = now()
  where id = p_task
  returning * into t;
  insert into public.task_events (task_id, actor, kind) values (p_task, coalesce(t.claimed_by_agent, 'unknown'), p_status);
  return query select 'ok'::text, to_jsonb(t);
end $$;

create or replace function public.hub_rate_hit(p_key text, p_window_seconds int, p_max int) returns bool
language sql
set search_path = public, extensions
as $$
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, date_bin(make_interval(secs => p_window_seconds), now(), timestamptz 'epoch'), 1)
  on conflict (key, window_start) do update set count = r.count + 1
  returning count <= p_max
$$;

-- ---------------------------------------------------------------------------
-- Lockdown: RLS on, zero policies; only service_role.
-- ---------------------------------------------------------------------------

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;
