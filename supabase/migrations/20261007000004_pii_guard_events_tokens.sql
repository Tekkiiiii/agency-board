-- agency-board: Confidential / data-class guard, DB backstop (CONTRACT §13 + §13.5 classes 3-5).
--   1. New rule functions (mirror lib/guard.ts; SQL may be narrower, see parity notes):
--        hub_credential_rule (class 5, ALL namespaces), hub_employee_rule (class 3), hub_financial_rule (class 4).
--   2. Redefines the 0002 guards hub_guard_memories / hub_guard_tasks / hub_guard_approvals (the 0002 file is
--      applied and is never edited; these `create or replace` bodies supersede it).
--   3. Adds the guards that had no DB backstop:
--        task_events.note                <- update_task note, handoff note, dashboard reassign note
--        agent_tokens.model/status_note  <- heartbeat
--        devices.machine_name            <- connect-code machine name   (credentials + customer/employee PII only)
--        confidential_projects.name      <- project create/rename       (credentials + customer/employee PII only)
-- Check order per row, across ALL guarded columns of the row (first hit wins):
--   credentials -> customer PII -> employee PII -> financials -> contract (contract only outside confidential).
-- Raises P0001 '<CODE>:<rule>' with CODE in CREDENTIALS_BLOCKED / CUSTOMER_PII_BLOCKED / EMPLOYEE_PII_BLOCKED /
-- FINANCIALS_BLOCKED / CONFIDENTIAL. Never echoes content.
-- The app layer (lib/guard.ts assertConfidentialTiers) checks first; this is defense in depth for any service-role write
-- that skips the handlers. Same style and lockdown as 20261007000002.
-- Depends on 20261007000002 (hub_pii_rule, hub_contract_rule, hub_conf_slug). Independent of ...0003.
-- No BEGIN/COMMIT here: the migration runner wraps the file in one transaction. Re-running is safe
-- (create or replace + drop trigger if exists). Existing rows are not re-checked (triggers fire on
-- INSERT and on UPDATE of the guarded columns only).
-- Postgres ARE notes: \m / \M are word boundaries (\b is backspace); JS lookbehinds are emulated with
-- (^|[^...]) prefixes; NFC-normalised like the JS guard.

-- ---------------------------------------------------------------------------
-- Rule functions. Exact mirrors of lib/guard.ts credentialRule / employeeRule / financialRule (source of truth for
-- rule ids). JS -> ARE translation: \p{L} -> [[:alpha:]], \p{Lu}/\p{Ll} -> [[:upper:]]/[[:lower:]] (these follow the
-- DB ctype; with an ICU en-US DB the non-ASCII letters of the Vietnamese rule pack classify correctly; on a C locale they degrade to ASCII,
-- i.e. the SQL backstop gets narrower, never broader). JS near(a, b, n) (gap between two match spans <= n, either
-- order) -> a.{0,n}b | b.{0,n}a (ARE '.' also crosses newlines, like the JS span arithmetic).
-- ---------------------------------------------------------------------------

-- Class 5: credentials / system info. Blocked in ALL namespaces.
create or replace function public.hub_credential_rule(t text) returns text
language plpgsql immutable parallel safe security invoker
set search_path = public, extensions
as $$
declare
  s text;
begin
  if t is null then return null; end if;
  s := normalize(t, NFC);
  -- password (i): keyword + ':' or '=' + a value ("use the password manager" passes)
  if s ~* '(?<![[:alpha:]])(mật khẩu|password|passwd|pwd)\s*[:=]\s*\S' then return 'password'; end if;
  -- secret_token (case-sensitive): known prefixes with a minimum body length, JWT, PEM private key
  if s ~ ('(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}'
       || '|(?<![A-Za-z0-9_-])sk_live_[A-Za-z0-9]{10,}'
       || '|(?<![A-Za-z0-9_-])gh[po]_[A-Za-z0-9]{20,}'
       || '|(?<![A-Za-z0-9_-])github_pat_[A-Za-z0-9_]{20,}'
       || '|(?<![A-Za-z0-9_-])xox[abp]-[A-Za-z0-9-]{10,}'
       || '|(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![0-9A-Z])'
       || '|(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}'
       || '|(?<![A-Za-z0-9_-])agency-board_[a-z][a-z0-9]{1,23}_[A-Za-z0-9_-]{20,}'
       || '|(?<![A-Za-z0-9_-])agency-board-admin_[A-Za-z0-9_-]{20,}'
       || '|eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.'
       || '|-----BEGIN [A-Z ]*PRIVATE KEY-----') then
    return 'secret_token';
  end if;
  -- conn_string (i): scheme://user:password@
  if s ~* '(?<![a-z])(postgres(ql)?|mysql|mongodb(\+srv)?|redis|amqp)://[^\s:]+:[^\s@]+@' then return 'conn_string'; end if;
  -- internal_host: private IPv4 (not part of a longer dotted number), *.local/.internal/.corp/.lan hosts,
  -- intranet hosts. "localhost:13100" passes (no dot before "local").
  if s ~ '(?<![0-9.])(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![0-9]|\.\d)'
     or s ~* ('(?<![[:alpha:][:digit:]-])[a-z0-9-]+(\.[a-z0-9-]+)*\.(local|internal|corp|lan)(?![[:alpha:][:digit:]-])(?!\.[a-z])'
           || '|(?<![[:alpha:][:digit:]-])(?:[a-z0-9-]+\.)*intranet[a-z0-9-]*\.[a-z]'
           || '|://intranet(?![[:alpha:][:digit:]])') then
    return 'internal_host';
  end if;
  return null;
end $$;

-- Class 3: employee PII.
--   staff_id  (i): staff-id label + an id of 3+ [A-Za-z0-9-] chars containing a digit ("employee id field" passes)
--   hr_record (i): HR keyword within 60 chars of a name_honorific / name_label / staff_id match. Implemented by
--                  masking every such match with chr(1) and testing kw.{0,60}chr(1) | chr(1).{0,60}kw.
create or replace function public.hub_employee_rule(t text) returns text
language plpgsql immutable parallel safe security invoker
set search_path = public, extensions
as $$
declare
  s text;
  m text;
  mark constant text := chr(1);
  staff constant text :=
    '(?<![[:alpha:]])(mã (nv|nhân viên|số nhân viên)|msnv|employee id|staff id|emp id)\s*(no\.?|number|#)?\s*[:#]?\s*(?=[A-Za-z-]*\d)[A-Za-z0-9-]{3,}';
  hr constant text :=
    '(?<![[:alpha:]])(lương|salary|đánh giá (hiệu suất|năng lực)|performance review|kỷ luật|disciplin[[:alpha:]]*)(?![[:alpha:]])';
begin
  if t is null then return null; end if;
  s := normalize(t, NFC);
  if s ~* staff then return 'staff_id'; end if;
  if s !~* hr then return null; end if;
  -- name_honorific is case-sensitive (same as JS NAME_HONORIFIC_RE, incl. the "Bà Rịa" province exclusion)
  m := regexp_replace(s,
         '(?<![[:alpha:][:digit:]])(Ông|Bà|Anh|Chị|Mr|Mrs|Ms)\.?\s+(?!Rịa(?![[:alpha:]]))[[:upper:]][[:lower:]]+(\s+[[:upper:]][[:lower:]]+)+',
         mark, 'g');
  m := regexp_replace(m,
         '(?<![[:alpha:]])(họ (và )?tên|tên kh|tên khách hàng|khách hàng|customer name|full name)\s*[:：]\s*\S',
         mark, 'gi');
  m := regexp_replace(m, staff, mark, 'gi');
  if position(mark in m) > 0 and m ~* (hr || '.{0,60}' || mark || '|' || mark || '.{0,60}' || hr) then
    return 'hr_record';
  end if;
  return null;
end $$;

-- Class 4: non-public financials.
--   amount: number + currency/magnitude unit, currency + number, bare 7+ digit integer, or 3+ thousand-groups
--   budget_amount / target_amount (i): keyword within 40 chars (either side) of an amount
--   rate_unpublished (i): (lãi suất|interest rate[s]) then within 40 non-% chars N% , unless a public marker that is
--                         not negated ("chưa công bố", "not public", "non-public", "unpublished" do not exempt)
create or replace function public.hub_financial_rule(t text) returns text
language plpgsql immutable parallel safe security invoker
set search_path = public, extensions
as $$
declare
  s text;
  amt constant text :=
    '((?<![[:alpha:][:digit:]])\d[\d.,]*\s*(tỷ|triệu|tr|k|nghìn|ngàn|vnd|vnđ|đ|usd|\$|bn|m|million|billion)(?![[:alpha:]])'
    || '|(?<![[:alpha:]])(\$|vnd|vnđ|usd)\s*\d'
    || '|(?<![0-9.,])\d{7,}(?![0-9])'
    || '|(?<![0-9.,])\d{1,3}([.,]\d{3}){2,}(?![0-9]))';
  budget constant text := '((?<![[:alpha:]])(ngân sách|budgets?|chi phí dự kiến)(?![[:alpha:]]))';
  target constant text := '((?<![[:alpha:]])(chỉ tiêu|targets?|kpis?|doanh số|dư nợ)(?![[:alpha:]]))';
begin
  if t is null then return null; end if;
  s := normalize(t, NFC);
  if s ~* (budget || '.{0,40}' || amt || '|' || amt || '.{0,40}' || budget) then return 'budget_amount'; end if;
  if s ~* (target || '.{0,40}' || amt || '|' || amt || '.{0,40}' || target) then return 'target_amount'; end if;
  if s ~* '(?<![[:alpha:]])(lãi suất|interest rates?)(?![[:alpha:]])[^%\n]{0,40}?\d+([.,]\d+)?\s*%'
     and s !~* '(?<![[:alpha:]-])(?<!chưa )(?<!not )(?<!not yet )(công bố|public|published|niêm yết)(?![[:alpha:]])' then
    return 'rate_unpublished';
  end if;
  return null;
end $$;

-- ---------------------------------------------------------------------------
-- Shared raiser (mirrors JS assertConfidentialTiers). p_texts = all guarded columns of one row, in column order.
-- Each class is checked over ALL texts before the next class. As in JS, a text whose customer-PII hit is a name rule
-- (name_label; name_honorific is not in hub_pii_rule) AND that is an hr_record counts as employee PII, not customer PII.
-- Contract is only checked when p_contract_ok is false. p_full = false (devices / confidential_projects) stops after
-- employee PII (narrower than JS, which also checks financials + contract on these fields).
-- ---------------------------------------------------------------------------
create or replace function public.hub_guard_check(p_texts text[], p_contract_ok bool, p_full bool default true)
returns void
language plpgsql immutable parallel safe security invoker
set search_path = public, extensions
as $$
declare
  x text;
  r text;
begin
  foreach x in array p_texts loop
    r := hub_credential_rule(x);
    if r is not null then raise exception using errcode = 'P0001', message = 'CREDENTIALS_BLOCKED:' || r; end if;
  end loop;
  foreach x in array p_texts loop
    r := hub_pii_rule(x);
    if r is not null and not (r = 'name_label' and hub_employee_rule(x) is not distinct from 'hr_record') then
      raise exception using errcode = 'P0001', message = 'CUSTOMER_PII_BLOCKED:' || r;
    end if;
  end loop;
  foreach x in array p_texts loop
    r := hub_employee_rule(x);
    if r is not null then raise exception using errcode = 'P0001', message = 'EMPLOYEE_PII_BLOCKED:' || r; end if;
  end loop;
  if not p_full then return; end if;
  foreach x in array p_texts loop
    r := hub_financial_rule(x);
    if r is not null then raise exception using errcode = 'P0001', message = 'FINANCIALS_BLOCKED:' || r; end if;
  end loop;
  if p_contract_ok then return; end if;
  foreach x in array p_texts loop
    r := hub_contract_rule(x);
    if r is not null then raise exception using errcode = 'P0001', message = 'CONFIDENTIAL:' || r; end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Guards. Triggers for memories / tasks / approvals come from 0001 (same column lists); only bodies change.
-- ---------------------------------------------------------------------------
create or replace function public.hub_guard_memories() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(
    array[new.namespace, new.slug, new.content, array_to_string(new.tags, ','), new.target_namespace],
    hub_conf_slug(new.namespace) is not distinct from 'confidential');
  return new;
end $$;

create or replace function public.hub_guard_tasks() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(
    array[new.namespace, new.title, new.body, new.result::text, new.handoff_to],
    hub_conf_slug(new.namespace) is not distinct from 'confidential');
  return new;
end $$;

-- approvals: contracts only when the linked task lives in confidential (no task -> not allowed)
create or replace function public.hub_guard_approvals() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(
    array[new.question, new.options::text, new.answer],
    coalesce((select hub_conf_slug(t.namespace) from public.tasks t where t.id = new.task_id)
             = 'confidential', false));
  return new;
end $$;

-- task_events.note: contract wording only on events of a task in confidential (no task -> not allowed)
create or replace function public.hub_guard_task_events() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  if new.note is null then return new; end if;
  perform hub_guard_check(
    array[new.note],
    coalesce((select hub_conf_slug(t.namespace) from public.tasks t where t.id = new.task_id)
             = 'confidential', false));
  return new;
end $$;

-- agent_tokens.model / status_note (heartbeat): contract wording never (§13.3 heartbeat row).
create or replace function public.hub_guard_agent_tokens() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(array[new.model, new.status_note], false);
  return new;
end $$;

-- devices.machine_name (connect-code machine name): credentials + customer/employee PII only.
create or replace function public.hub_guard_devices() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(array[new.machine_name], false, false);
  return new;
end $$;

-- confidential_projects.name (project create/rename): credentials + customer/employee PII only.
create or replace function public.hub_guard_confidential_projects() returns trigger
language plpgsql security invoker
set search_path = public, extensions
as $$
begin
  perform hub_guard_check(array[new.name], false, false);
  return new;
end $$;

drop trigger if exists task_events_confidential_guard on public.task_events;
create trigger task_events_confidential_guard before insert or update of note, task_id
  on public.task_events for each row execute function public.hub_guard_task_events();

drop trigger if exists agent_tokens_confidential_guard on public.agent_tokens;
create trigger agent_tokens_confidential_guard before insert or update of model, status_note
  on public.agent_tokens for each row execute function public.hub_guard_agent_tokens();

drop trigger if exists devices_confidential_guard on public.devices;
create trigger devices_confidential_guard before insert or update of machine_name
  on public.devices for each row execute function public.hub_guard_devices();

drop trigger if exists confidential_projects_confidential_guard on public.confidential_projects;
create trigger confidential_projects_confidential_guard before insert or update of name
  on public.confidential_projects for each row execute function public.hub_guard_confidential_projects();

-- ---------------------------------------------------------------------------
-- Lockdown (same as 0001/0002): only service_role executes functions.
-- ---------------------------------------------------------------------------

revoke all on function public.hub_credential_rule(text) from public, anon, authenticated;
revoke all on function public.hub_employee_rule(text) from public, anon, authenticated;
revoke all on function public.hub_financial_rule(text) from public, anon, authenticated;
revoke all on function public.hub_guard_check(text[], bool, bool) from public, anon, authenticated;
revoke all on function public.hub_guard_memories() from public, anon, authenticated;
revoke all on function public.hub_guard_tasks() from public, anon, authenticated;
revoke all on function public.hub_guard_approvals() from public, anon, authenticated;
revoke all on function public.hub_guard_task_events() from public, anon, authenticated;
revoke all on function public.hub_guard_agent_tokens() from public, anon, authenticated;
revoke all on function public.hub_guard_devices() from public, anon, authenticated;
revoke all on function public.hub_guard_confidential_projects() from public, anon, authenticated;
grant execute on function public.hub_credential_rule(text) to service_role;
grant execute on function public.hub_employee_rule(text) to service_role;
grant execute on function public.hub_financial_rule(text) to service_role;
grant execute on function public.hub_guard_check(text[], bool, bool) to service_role;
grant execute on function public.hub_guard_memories() to service_role;
grant execute on function public.hub_guard_tasks() to service_role;
grant execute on function public.hub_guard_approvals() to service_role;
grant execute on function public.hub_guard_task_events() to service_role;
grant execute on function public.hub_guard_agent_tokens() to service_role;
grant execute on function public.hub_guard_devices() to service_role;
grant execute on function public.hub_guard_confidential_projects() to service_role;
