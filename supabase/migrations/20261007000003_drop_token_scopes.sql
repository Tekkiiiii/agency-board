-- agency-board MVP-b0 cleanup (CONTRACT §14). Apply ONLY after the role-based code is live in prod:
-- scopes are derived from agent_roles per request, so the per-token scope columns are dead.
alter table public.agent_tokens
  drop column if exists read_ns,
  drop column if exists write_ns,
  drop column if exists inbox_only;
