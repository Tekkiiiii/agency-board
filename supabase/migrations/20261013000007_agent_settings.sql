-- agency-board: per-agent@machine listen/wait check interval (the dashboard slider behind /listen and /wait).
--   public.agent_settings (agent, device_id) -> listen_minutes smallint 0..60, default 30; 0 = listening/waiting is off.
--   Own table (not system_flags: global + boolean + CHECK-limited keys; not agent_tokens: a rotated token would lose the value).
--   Keyed like agent_roles / grants (0002): primary key (agent, device_id), on delete cascade with the device.
-- Depends on 0001 (devices). Re-running is safe (if not exists / enable RLS / grants are idempotent).
-- No BEGIN/COMMIT: the migration runner wraps the file in one transaction. 0001-0006 are never edited.
-- Deploy order: the app tolerates this table being absent (every reader falls back to 30), so the app may ship first; the
-- setting only becomes writable once this migration is applied.

create table if not exists public.agent_settings (
  agent text not null check (agent in ('claude','codex','hermes','grok')),
  device_id uuid not null references public.devices(id) on delete cascade,
  listen_minutes smallint not null default 30 check (listen_minutes between 0 and 60),
  updated_at timestamptz not null default now(),
  primary key (agent, device_id)
);

-- Lockdown as in 0001/0002: RLS on with zero policies, only service_role. (0001's default privileges already cover new tables;
-- the explicit statements below keep this file correct on its own.)
alter table public.agent_settings enable row level security;
revoke all on public.agent_settings from anon, authenticated;
grant all on public.agent_settings to service_role;
