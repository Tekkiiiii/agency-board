-- agency-board MVP-b0: roles + confidential grants + confidential tiered guard (§13: contracts gated, customer PII blocked).
-- Source of truth: docs/CONTRACT.md sections 11-14. Applies on top of 20261007000001_init.sql
-- on a live DB with data. No BEGIN/COMMIT here: the migration runner wraps the file in one
-- transaction. Re-running is safe (if not exists / on conflict / drop-if-exists + create or replace).
--
-- Backward compatible with the MVP-a code still deployed: agent_tokens.read_ns/write_ns/inbox_only
-- stay (nullable, default '{}') until 20261007000003; every replaced RPC keeps its old named params,
-- the new params have defaults.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.agent_roles (
  agent text not null check (agent ~ '^[a-z][a-z0-9]{1,23}$'),
  device_id uuid not null references public.devices(id) on delete cascade,
  role text not null check (role in ('director','lead','member')),
  updated_at timestamptz not null default now(),
  primary key (agent, device_id)
);
-- one director at a time
create unique index if not exists agent_roles_one_director on public.agent_roles ((true)) where role = 'director';

create table if not exists public.confidential_projects (
  slug text primary key check (slug ~ '^[a-z0-9-]{1,40}$'),
  name text not null check (length(name) between 1 and 80),
  created_at timestamptz not null default now()
);

create table if not exists public.grants (
  agent text not null check (agent ~ '^[a-z][a-z0-9]{1,23}$'),
  device_id uuid not null references public.devices(id) on delete cascade,
  project_slug text not null references public.confidential_projects(slug) on delete cascade,
  granted_by text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (agent, device_id, project_slug)
);
create index if not exists grants_project_idx on public.grants (project_slug);
create index if not exists grants_device_idx on public.grants (device_id);
create index if not exists agent_roles_device_idx on public.agent_roles (device_id);

create table if not exists public.admin_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null default 'owner',
  action text not null check (action in ('role_set','grant','revoke','project_create','project_rename')),
  target text not null,
  detail jsonb not null default '{}'
);
create index if not exists admin_audit_at_idx on public.admin_audit (at desc);

-- ident (agent@machine) of whoever last set handoff_to
alter table public.tasks add column if not exists assigned_by text;

-- who decided an approval: 'owner' (admin/dashboard) or the director's ident (§13.4)
alter table public.approvals add column if not exists decided_by text;

-- token scopes are now derived from the role; columns dropped in ...0003
alter table public.agent_tokens alter column read_ns drop not null;
alter table public.agent_tokens alter column read_ns set default '{}';
alter table public.agent_tokens alter column write_ns drop not null;
alter table public.agent_tokens alter column write_ns set default '{}';

-- (0001 no longer carries name-based CHECKs on memories / tasks / agent_tokens; nothing to drop here.)

-- ---------------------------------------------------------------------------
-- Seeds
-- ---------------------------------------------------------------------------

-- A project is not confidential just because it is named after a client (§13 tier 1); only contracts live in
-- confidential. The agent column is FORMAT-checked only (^[a-z][a-z0-9]{1,23}$); the app validates membership
-- against AGENCY_BOARD_AGENTS, so the set of agents is deployment config, not schema.
insert into public.confidential_projects (slug, name) values ('confidential', 'Confidential')
on conflict (slug) do nothing;

-- No agent_roles seed: a fresh install has no director. After the first device is connected, bootstrap it with
-- `node scripts/admin.mjs role <agent> <deviceId> director` (or the dashboard Devices page).

-- ---------------------------------------------------------------------------
-- Confidentiality helpers (§12)
-- ---------------------------------------------------------------------------

create or replace function public.hub_conf_slug(ns text) returns text
language sql stable parallel safe
set search_path = public, extensions
as $$
  select c.slug from public.confidential_projects c
  where split_part(ns, '/', 1) = 'project' and c.slug = split_part(ns, '/', 2)
$$;

create or replace function public.hub_readable(ns text, patterns text[], granted text[]) returns bool
language sql stable parallel safe
set search_path = public, extensions
as $$
  select public.hub_ns_match(ns, patterns)
     and (public.hub_conf_slug(ns) is null or public.hub_conf_slug(ns) = any(coalesce(granted, '{}'::text[])))
$$;

-- ---------------------------------------------------------------------------
-- Identity resolution (§11, §14). One round trip per request.
-- ---------------------------------------------------------------------------

-- p_lead_agents = agents whose DEFAULT role (no agent_roles row) is lead; every other agent defaults to member.
-- The app passes AGENCY_BOARD_LEAD_AGENTS on every call (lib/auth.ts); the DB cannot read env. Single overload.
create or replace function public.hub_resolve_token(p_hash text, p_lead_agents text[] default array['claude','codex']) returns jsonb
language sql stable
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'token_id', t.id,
    'agent', t.agent,
    'device_id', t.device_id,
    'machine', d.machine_name,
    'token_revoked', t.revoked_at is not null,
    'device_revoked', coalesce(d.revoked_at is not null, false),
    'role', coalesce(
      (select r.role from public.agent_roles r where r.agent = t.agent and r.device_id = t.device_id),
      case when t.agent = any(p_lead_agents) then 'lead' else 'member' end),
    'grants', coalesce(
      (select array_agg(g.project_slug order by g.project_slug)
       from public.grants g where g.agent = t.agent and g.device_id = t.device_id), '{}'::text[]),
    'assigned', coalesce(
      (select array_agg(distinct 'project/' || split_part(k.namespace, '/', 2) || '/*')
       from public.tasks k
       where k.status in ('open','claimed')
         and starts_with(k.namespace, 'project/')
         and (k.handoff_to = t.agent
              or (d.machine_name is not null and k.handoff_to = t.agent || '@' || d.machine_name)
              or k.claimed_by_token = t.id)), '{}'::text[]),
    'confidential', coalesce(
      (select array_agg(c.slug order by c.slug) from public.confidential_projects c), '{}'::text[])
  )
  from public.agent_tokens t
  left join public.devices d on d.id = t.device_id
  where t.token_hash = p_hash
$$;

-- ---------------------------------------------------------------------------
-- Admin mutations (§11, §12). Audited.
-- ---------------------------------------------------------------------------

create or replace function public.hub_set_role(p_agent text, p_device uuid, p_role text, p_lead_agents text[] default array['claude','codex']) returns jsonb
language plpgsql
set search_path = public, extensions
as $$
declare
  v_machine text;
  v_from text;
  v_demoted text;
begin
  if p_role is null or p_role not in ('director','lead','member') then
    raise exception using errcode = '22023', message = 'INVALID_ROLE';
  end if;
  if p_agent is null or p_agent !~ '^[a-z][a-z0-9]{1,23}$' then
    raise exception using errcode = '22023', message = 'INVALID_AGENT';
  end if;
  select machine_name into v_machine from public.devices where id = p_device;
  if not found then
    raise exception using errcode = '22023', message = 'UNKNOWN_DEVICE';
  end if;

  select role into v_from from public.agent_roles where agent = p_agent and device_id = p_device for update;
  if not found then
    v_from := case when p_agent = any(p_lead_agents) then 'lead' else 'member' end;
  end if;

  if p_role = 'director' then
    update public.agent_roles r set role = 'lead', updated_at = now()
    from public.devices d
    where d.id = r.device_id and r.role = 'director'
      and not (r.agent = p_agent and r.device_id = p_device)
    returning r.agent || '@' || d.machine_name into v_demoted;
  end if;

  insert into public.agent_roles (agent, device_id, role, updated_at)
  values (p_agent, p_device, p_role, now())
  on conflict (agent, device_id) do update set role = excluded.role, updated_at = excluded.updated_at;

  insert into public.admin_audit (action, target, detail)
  values ('role_set', p_agent || '@' || v_machine,
          jsonb_strip_nulls(jsonb_build_object('from', v_from, 'to', p_role, 'demoted', v_demoted)));

  return jsonb_build_object('agent', p_agent, 'device_id', p_device, 'role', p_role, 'demoted', v_demoted);
end $$;

create or replace function public.hub_set_grant(p_agent text, p_device uuid, p_slug text, p_granted bool) returns bool
language plpgsql
set search_path = public, extensions
as $$
declare
  v_machine text;
  n int;
begin
  if p_agent is null or p_agent !~ '^[a-z][a-z0-9]{1,23}$' then
    raise exception using errcode = '22023', message = 'INVALID_AGENT';
  end if;
  if not exists (select 1 from public.confidential_projects where slug = p_slug) then
    raise exception using errcode = '22023', message = 'UNKNOWN_PROJECT';
  end if;
  select machine_name into v_machine from public.devices where id = p_device;
  if not found then
    raise exception using errcode = '22023', message = 'UNKNOWN_DEVICE';
  end if;

  if p_granted then
    insert into public.grants (agent, device_id, project_slug) values (p_agent, p_device, p_slug)
    on conflict do nothing;
  else
    delete from public.grants where agent = p_agent and device_id = p_device and project_slug = p_slug;
  end if;
  get diagnostics n = row_count;

  if n > 0 then
    insert into public.admin_audit (action, target, detail)
    values (case when p_granted then 'grant' else 'revoke' end, p_agent || '@' || v_machine,
            jsonb_build_object('project', p_slug));
  end if;
  return n > 0;
end $$;

-- ---------------------------------------------------------------------------
-- Search / graph with grants. Old signatures dropped first: no overloads remain.
-- ---------------------------------------------------------------------------

drop function if exists public.hub_search(extensions.vector, text, text[], text, text, int, text);
drop function if exists public.hub_neighbors(uuid[], text[], text, int, int);
drop function if exists public.hub_autolink(uuid, text[], int, real);
drop function if exists public.hub_claim(uuid, uuid, text, int);

create or replace function public.hub_search(
  q_embedding extensions.vector(384), q_text text, read_patterns text[], caller_agent text,
  ns_filter text default null, k int default 10, q_model text default 'gte-small',
  granted text[] default '{}')
returns table(id uuid, namespace text, slug text, content text, tags text[], author_agent text,
              author_device text, created_at timestamptz, updated_at timestamptz, flags text[],
              review_status text, pinned bool, score double precision)
language sql stable
set search_path = public, extensions
as $$
  with vis as (
    select m.* from public.memories m
    where hub_readable(m.namespace, read_patterns, granted)
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

-- Readability (scope AND grant) + visibility checked on every node before it is returned OR
-- expanded, so an unreadable / ungranted node is a wall, not a bridge. Seeds must be readable.
create or replace function public.hub_neighbors(
  seed_ids uuid[], read_patterns text[], caller_agent text, max_depth int default 1, max_nodes int default 50,
  granted text[] default '{}')
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
    where s.id = any(seed_ids) and hub_readable(s.namespace, read_patterns, granted) and hub_visible(s, caller_agent)
  ),
  walk(seed_id, id, depth, relation, direction, auto, score, path) as (
    select sd.id, e.b, 1, e.relation, e.dir, e.auto, e.score, array[sd.id, e.b]
    from seeds sd
    join edges e on e.a = sd.id
    join public.memories m on m.id = e.b
    where hub_readable(m.namespace, read_patterns, granted) and hub_visible(m, caller_agent)
    union all
    select w.seed_id, e.b, w.depth + 1, e.relation, e.dir, e.auto, e.score, w.path || e.b
    from walk w
    join edges e on e.a = w.id
    join public.memories m on m.id = e.b
    where w.depth < least(greatest(max_depth, 1), 2)
      and not (e.b = any(w.path))
      and hub_readable(m.namespace, read_patterns, granted) and hub_visible(m, caller_agent)
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

create or replace function public.hub_autolink(p_id uuid, read_patterns text[], k int default 3, threshold real default 0.85,
  granted text[] default '{}')
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
    and hub_readable(m.namespace, read_patterns, granted)
    and hub_visible(m, s.author_agent)
    and 1 - (m.embedding <=> s.embedding) >= threshold
  order by m.embedding <=> s.embedding
  limit greatest(k, 0)
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Coordination: claim accepts handoff_to = agent OR agent@machine (§14)
-- ---------------------------------------------------------------------------

create or replace function public.hub_claim(p_task uuid, p_token uuid, p_agent text, p_lease_seconds int default 600,
  p_ident text default null)
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
      and (t.handoff_to is null or t.handoff_to = p_agent or (p_ident is not null and t.handoff_to = p_ident))
    returning t.*
  ), e as (
    insert into public.task_events (task_id, actor, kind) select c.id, p_agent, 'claimed' from c
  )
  select * from c
$$;

-- ---------------------------------------------------------------------------
-- confidential tiered guard (§13). Tier 3 customer PII: blocked everywhere (incl. confidential).
-- Tier 2 contracts: allowed only in confidential project `confidential`. Tier 1: no DB rule.
-- Rule ids mirror lib/guard.ts piiRule / contractRule. SQL is the backstop and may be narrower (§13.1
-- parity: name_honorific is JS-only). Postgres ARE: \m / \M are word boundaries (\b is backspace);
-- the JS lookbehind on phones is emulated with (^|[^0-9+]). Never echoes content.
-- hub_confidential_rule (0001) is left in place but no longer called by any guard.
-- ---------------------------------------------------------------------------

create or replace function public.hub_pii_rule(t text) returns text
language plpgsql immutable parallel safe
set search_path = public, extensions
as $$
declare
  s text;
  m text[];
begin
  if t is null then return null; end if;
  s := normalize(t, NFC);
  -- cccd: 12 digits, province 0xx, gender/century digit 0-3; not inside a longer number
  if s ~ '(^|[^0-9])0\d{2}[0-3]\d{8}([^0-9]|$)' then return 'cccd'; end if;
  -- id_keyword (i): ID-document keyword then an (optionally letter-prefixed) 7-12 digit number
  if s ~* '(^|[^[:alpha:][:digit:]])(cmnd|cccd|cmt|căn cước|chứng minh|hộ chiếu|passport|id no\.?)\D{0,15}[A-Z]?\d{7,12}([^0-9]|$)' then
    return 'id_keyword';
  end if;
  -- phone: VN mobile, +84 / 84 / 0 prefix, separators (space . -) allowed between digits
  if s ~ '(^|[^0-9+])(\+?84|0)[\s.-]?[35789](\d[\s.-]?){7}\d([^0-9]|$)' then return 'phone'; end if;
  -- card: plain 13-19 digits, 4-4-4-4(+1..3) groups, or 4-6-4/5 (Amex/Diners); Luhn-checked
  for m in select regexp_matches(s,
      '(?:^|[^0-9])(\d{13,19}|\d{4}(?:[ -]\d{4}){3}(?:[ -]?\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{4,5})(?![0-9])', 'g') loop
    if public.hub_luhn(m[1]) then return 'card'; end if;
  end loop;
  -- account (i): account-number keyword then 6+ digits
  if s ~* '(^|[^[:alpha:]])(stk|s[oố] t[aà]i kho[aả]n|account (no|number|#)|tk ngân hàng)\D{0,5}\d{6,}' then
    return 'account';
  end if;
  -- name_label (i): label + colon + value ("Khách hàng SME" without a colon passes)
  if s ~* '(^|[^[:alpha:]])(họ (và )?tên|tên kh|tên khách hàng|khách hàng|customer name|full name)\s*[:：]\s*\S' then
    return 'name_label';
  end if;
  -- name_honorific: JS-only (§13.1 parity note)
  return null;
end $$;

create or replace function public.hub_contract_rule(t text) returns text
language plpgsql immutable parallel safe
set search_path = public, extensions
as $$
declare
  s text;
begin
  if t is null then return null; end if;
  s := normalize(t, NFC);
  -- contract-number rules need an id containing a digit ("hợp đồng số hoá" passes)
  if s ~* '(^|[^[:alpha:]])(hợp đồng|hđ)\s*(số|no\.?)\s*[:#]?\s*[A-Za-z]{0,6}[-/]?\d' then
    return 'contract_no_vi';
  end if;
  if s ~* '(^|[^[:alpha:]])số hợp đồng\s*[:：#]\s*\S' then return 'contract_number_label'; end if;
  if s ~ '(^|[^[:alpha:][:digit:]])Bên A([^[:alpha:][:digit:]]|$)'
     and s ~ '(^|[^[:alpha:][:digit:]])Bên B([^[:alpha:][:digit:]]|$)' then
    return 'parties_ab';
  end if;
  if s ~ '(^|[^[:alpha:][:digit:]])Điều 1([^[:alpha:][:digit:]]|$)' and s ~* 'hợp đồng' then
    return 'article_1';
  end if;
  if s ~* '(^|[^[:alpha:]])contract no(\.|(?![a-z]))\s*[:#]?\s*[A-Za-z]{0,6}[-/]?\d' then
    return 'contract_no_en';
  end if;
  if s ~* 'agreement between' and s ~* 'the parties' then return 'agreement_parties'; end if;
  return null;
end $$;

-- Triggers from 0001 are unchanged (same column lists); only the functions are replaced.
create or replace function public.hub_guard_memories() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_pii_rule(new.namespace), hub_pii_rule(new.slug), hub_pii_rule(new.content),
                hub_pii_rule(array_to_string(new.tags, ',')), hub_pii_rule(new.target_namespace));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_PII_BLOCKED:' || r;
  end if;
  if hub_conf_slug(new.namespace) is distinct from 'confidential' then
    r := coalesce(hub_contract_rule(new.namespace), hub_contract_rule(new.slug), hub_contract_rule(new.content),
                  hub_contract_rule(array_to_string(new.tags, ',')), hub_contract_rule(new.target_namespace));
    if r is not null then
      raise exception using errcode = 'P0001', message = 'CONFIDENTIAL:' || r;
    end if;
  end if;
  return new;
end $$;

create or replace function public.hub_guard_tasks() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_pii_rule(new.namespace), hub_pii_rule(new.title), hub_pii_rule(new.body),
                hub_pii_rule(new.result::text), hub_pii_rule(new.handoff_to));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_PII_BLOCKED:' || r;
  end if;
  if hub_conf_slug(new.namespace) is distinct from 'confidential' then
    r := coalesce(hub_contract_rule(new.namespace), hub_contract_rule(new.title), hub_contract_rule(new.body),
                  hub_contract_rule(new.result::text), hub_contract_rule(new.handoff_to));
    if r is not null then
      raise exception using errcode = 'P0001', message = 'CONFIDENTIAL:' || r;
    end if;
  end if;
  return new;
end $$;

create or replace function public.hub_guard_approvals() returns trigger
language plpgsql
set search_path = public, extensions
as $$
declare r text;
begin
  r := coalesce(hub_pii_rule(new.question), hub_pii_rule(new.options::text), hub_pii_rule(new.answer));
  if r is not null then
    raise exception using errcode = 'P0001', message = 'CUSTOMER_PII_BLOCKED:' || r;
  end if;
  -- contracts only when the linked task lives in confidential (no task -> not allowed)
  if (select hub_conf_slug(t.namespace) from public.tasks t where t.id = new.task_id)
       is distinct from 'confidential' then
    r := coalesce(hub_contract_rule(new.question), hub_contract_rule(new.options::text), hub_contract_rule(new.answer));
    if r is not null then
      raise exception using errcode = 'P0001', message = 'CONFIDENTIAL:' || r;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Lockdown (same as 0001): RLS on, zero policies; only service_role.
-- ---------------------------------------------------------------------------

alter table public.agent_roles enable row level security;
alter table public.confidential_projects enable row level security;
alter table public.grants enable row level security;
alter table public.admin_audit enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
