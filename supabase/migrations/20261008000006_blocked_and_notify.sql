-- agency-board C6 (CONTRACT §19 server gaps): `blocked` task status + atomic complete-and-notify.
--   1. tasks.status CHECK gains 'blocked'; task_events.kind CHECK gains 'blocked' (event written by update_task status=blocked).
--   2. tasks.notify_pending boolean: set by hub_complete when a notify target is given, cleared by claim or by ack_task.
--   3. hub_complete: old 5-arg function dropped, re-created with trailing p_notify / p_ident / p_note (all default null,
--      so the old 5-arg call shape keeps working). On outcome ok with p_notify: handoff_to, assigned_by, notify_pending are
--      set in the SAME update as status/result. `blocked` is not terminal: the replay check stays status in ('done','failed').
--   4. hub_claim: a blocked task is claimable only when routed (handoff_to not null and = agent or ident). Claim clears notify_pending.
--   5. hub_resolve_token (only SQL that enumerates task statuses, 0002): `assigned` namespaces now also cover blocked tasks
--      routed to the identity and done/failed tasks with notify_pending, so a member that is blocked-routed / notified can
--      still read (canRead) and ack/claim the row. Clearing notify_pending (ack or claim) revokes the extra scope again.
--   Re-checked and left alone: hub_renew (status = 'claimed' only; a blocked row has no lease), hub_guard_tasks /
--   hub_guard_task_events (read text columns, no status), cron/daily (no task sweep), lease expiry (lazy, inside hub_claim,
--   status = 'claimed' only), so a blocked row is never swept or treated as an expired lease.
-- Depends on 0001 (tasks, task_events, hub_complete), 0002 (assigned_by, hub_claim, hub_resolve_token).
-- No BEGIN/COMMIT: the runner wraps the file in one transaction. 0001-0005 are never edited.
-- Deploy order: THIS MIGRATION FIRST, then the app (handlers reference notify_pending / 'blocked').

-- 1. status CHECK (inline in 0001, default name tasks_status_check; looked up by definition, never guessed)
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.contype = 'c' and c.conrelid = 'public.tasks'::regclass
      and pg_get_constraintdef(c.oid) ilike '%status%' and pg_get_constraintdef(c.oid) ilike '%cancelled%'
  loop
    execute format('alter table public.tasks drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.tasks add constraint tasks_status_check
  check (status in ('open','claimed','blocked','done','failed','cancelled'));

-- task_events.kind CHECK (inline in 0001, default name task_events_kind_check)
do $$
declare r record;
begin
  for r in
    select c.conname
    from pg_constraint c
    where c.contype = 'c' and c.conrelid = 'public.task_events'::regclass
      and pg_get_constraintdef(c.oid) ilike '%kind%' and pg_get_constraintdef(c.oid) ilike '%retried%'
  loop
    execute format('alter table public.task_events drop constraint %I', r.conname);
  end loop;
end $$;
alter table public.task_events add constraint task_events_kind_check
  check (kind in ('created','claimed','renewed','handoff','update','done','failed','released','cancelled','retried','blocked'));

-- 2. notify flag + partial index for the inbox queries (blocked routed to me / notified done|failed)
alter table public.tasks add column if not exists notify_pending boolean not null default false;
create index if not exists tasks_handoff_blocked_notify_idx on public.tasks (handoff_to) where status = 'blocked' or notify_pending;

-- 3. hub_complete
drop function if exists public.hub_complete(uuid, uuid, text, jsonb, text);

create or replace function public.hub_complete(p_task uuid, p_token uuid, p_key text, p_result jsonb, p_status text default 'done',
  p_notify text default null, p_ident text default null, p_note text default null)
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
         completed_at = now(), lease_expires_at = null, updated_at = now(),
         handoff_to = case when p_notify is not null then p_notify else handoff_to end,
         assigned_by = case when p_notify is not null then coalesce(p_ident, assigned_by) else assigned_by end,
         notify_pending = case when p_notify is not null then true else notify_pending end
  where id = p_task
  returning * into t;
  insert into public.task_events (task_id, actor, kind, note)
  values (p_task, coalesce(t.claimed_by_agent, 'unknown'), p_status,
          case when p_notify is not null then 'notify ' || p_notify || coalesce(': ' || p_note, '') else p_note end);
  return query select 'ok'::text, to_jsonb(t);
end $$;

-- 4. hub_claim (copy of 0002 + blocked-routed clause + notify_pending cleared; signature unchanged)
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
      notify_pending = false,
      updated_at = now()
    where t.id = p_task
      and (t.status = 'open'
           or (t.status = 'claimed' and t.lease_expires_at < now())
           or (t.status = 'blocked' and t.handoff_to is not null))
      and (t.handoff_to is null or t.handoff_to = p_agent or (p_ident is not null and t.handoff_to = p_ident))
    returning t.*
  ), e as (
    insert into public.task_events (task_id, actor, kind) select c.id, p_agent, 'claimed' from c
  )
  select * from c
$$;

-- 5. hub_resolve_token (copy of 0002 incl. p_lead_agents; only the `assigned` status filter changes)
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
       where (k.status in ('open','claimed','blocked') or (k.status in ('done','failed') and k.notify_pending))
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

-- Lockdown (same statements as 0001/0002): only service_role executes functions. Needed because hub_complete was
-- dropped and re-created (a fresh function inherits no explicit grants).
revoke all on function public.hub_complete(uuid, uuid, text, jsonb, text, text, text, text) from public, anon, authenticated;
grant execute on function public.hub_complete(uuid, uuid, text, jsonb, text, text, text, text) to service_role;
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on all functions in schema public to service_role;
