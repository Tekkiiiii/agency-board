-- agency-board: contract routing confidential-only (CONTRACT §13 / §13.2 / §13.3, dev-plan C1).
-- Contract wording (hub_contract_rule) is blocked ONLY in confidential context and only outside confidential.
-- Non-confidential contracts (e.g. an unrelated client contract in project/x) are stored normally.
-- Classes credentials / customer PII / employee PII / financials are UNCHANGED (hub_guard_check is not redefined).
--
-- Confidential context = hub_confidential_context(ns, texts), exact mirror of lib/guard.ts confidentialContext:
--   namespace ~* '^project/confidential[^/]*(/|$)'  (project slug starts with "confidential", case-insensitive), OR
--   any text ~* 'confidential' (NFC-normalised, like the JS guard).
-- The slug `confidential` and this marker are constants here AND in lib/guard.ts (CONFIDENTIAL_SLUG,
-- CONFIDENTIAL_NS_RE, CONFIDENTIAL_MARKER_RE); change them in both places together.
-- The guards keep calling hub_guard_check(texts, p_contract_ok); only p_contract_ok changes:
--   p_contract_ok = (conf slug is confidential) OR NOT hub_confidential_context(ns, texts + marker-only context).
-- Marker-only context (never tier-checked, mirrors the JS ContractGate.context): approvals / task_events also read the
-- linked task's namespace, title, body, handoff_to (JS taskGate + decideApproval). Rows without a namespace
-- (agent_tokens, approvals/task_events without a task) are confidential context only when a marker is present.
-- devices / confidential_projects (p_full = false) never checked contracts in SQL; unchanged (JS checks them).
-- Depends on 20261007000002 (hub_conf_slug, hub_contract_rule) and ...0004 (hub_guard_check + the guard functions this
-- file supersedes). 0001-0004 are applied and never edited; these `create or replace` bodies supersede them.
-- No BEGIN/COMMIT: the runner wraps the file in one transaction. Re-running is safe (create or replace only; the
-- triggers from 0001/0004 already point at these function names). Existing rows are not re-checked.
-- Postgres ARE: ~* case-folds per the DB ctype (the marker is ASCII, so this is locale-independent).

create or replace function public.hub_confidential_context(p_ns text, p_texts text[]) returns bool
language plpgsql immutable parallel safe security invoker
set search_path = public, extensions
as $$
declare
  x text;
begin
  if p_ns is not null and normalize(p_ns, NFC) ~* '^project/confidential[^/]*(/|$)' then return true; end if;
  if p_texts is null then return false; end if;
  foreach x in array p_texts loop
    if x is not null and normalize(x, NFC) ~* 'confidential' then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- Guards (bodies supersede 0004; triggers unchanged).
-- ---------------------------------------------------------------------------
create or replace function public.hub_guard_memories() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
declare
  texts text[] := array[new.namespace, new.slug, new.content, array_to_string(new.tags, ','), new.target_namespace];
begin
  perform hub_guard_check(
    texts,
    hub_conf_slug(new.namespace) is not distinct from 'confidential'
      or not hub_confidential_context(new.namespace, texts));
  return new;
end $$;

create or replace function public.hub_guard_tasks() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
declare
  texts text[] := array[new.namespace, new.title, new.body, new.result::text, new.handoff_to];
begin
  perform hub_guard_check(
    texts,
    hub_conf_slug(new.namespace) is not distinct from 'confidential'
      or not hub_confidential_context(new.namespace, texts));
  return new;
end $$;

-- approvals: confidential contracts only when the linked task lives in confidential; context = the row + the task.
create or replace function public.hub_guard_approvals() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
declare
  texts text[] := array[new.question, new.options::text, new.answer];
  t record;
begin
  select tk.namespace, tk.title, tk.body, tk.handoff_to into t from public.tasks tk where tk.id = new.task_id;
  perform hub_guard_check(
    texts,
    coalesce(hub_conf_slug(t.namespace) = 'confidential', false)
      or not hub_confidential_context(t.namespace, texts || array[t.title, t.body, t.handoff_to]));
  return new;
end $$;

-- task_events.note: confidential contracts only on events of a confidential task; context = note + the task.
create or replace function public.hub_guard_task_events() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
declare
  t record;
begin
  if new.note is null then return new; end if;
  select tk.namespace, tk.title, tk.body, tk.handoff_to into t from public.tasks tk where tk.id = new.task_id;
  perform hub_guard_check(
    array[new.note],
    coalesce(hub_conf_slug(t.namespace) = 'confidential', false)
      or not hub_confidential_context(t.namespace, array[new.note, t.title, t.body, t.handoff_to]));
  return new;
end $$;

-- agent_tokens.model / status_note (heartbeat): no namespace -> contract wording blocked only with a confidential marker.
create or replace function public.hub_guard_agent_tokens() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
declare
  texts text[] := array[new.model, new.status_note];
begin
  perform hub_guard_check(texts, not hub_confidential_context(null, texts));
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Lockdown (same as 0001/0002/0004): only service_role executes functions.
-- ---------------------------------------------------------------------------
revoke all on function public.hub_confidential_context(text, text[]) from public, anon, authenticated;
revoke all on function public.hub_guard_memories() from public, anon, authenticated;
revoke all on function public.hub_guard_tasks() from public, anon, authenticated;
revoke all on function public.hub_guard_approvals() from public, anon, authenticated;
revoke all on function public.hub_guard_task_events() from public, anon, authenticated;
revoke all on function public.hub_guard_agent_tokens() from public, anon, authenticated;
grant execute on function public.hub_confidential_context(text, text[]) to service_role;
grant execute on function public.hub_guard_memories() to service_role;
grant execute on function public.hub_guard_tasks() to service_role;
grant execute on function public.hub_guard_approvals() to service_role;
grant execute on function public.hub_guard_task_events() to service_role;
grant execute on function public.hub_guard_agent_tokens() to service_role;
