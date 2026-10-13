// Migration 0007 (agent_settings) SQL-text checks, no DB. The DB-backed behaviour is in tests/agent-settings.test.ts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "20261013000007_agent_settings.sql"), "utf8");

describe("migration 0007: agent_settings", () => {
  it("creates public.agent_settings keyed (agent, device_id), idempotent, no BEGIN/COMMIT", () => {
    expect(sql).toMatch(/create table if not exists public\.agent_settings \(/);
    expect(sql).toMatch(/agent text not null check \(agent in \('claude','codex','hermes','grok'\)\)/);
    expect(sql).toMatch(/device_id uuid not null references public\.devices\(id\) on delete cascade/);
    expect(sql).toMatch(/listen_minutes smallint not null default 30 check \(listen_minutes between 0 and 60\)/);
    expect(sql).toMatch(/updated_at timestamptz not null default now\(\)/);
    expect(sql).toMatch(/primary key \(agent, device_id\)/);
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });
  it("locks the table down like 0002: RLS on, anon/authenticated revoked, service_role granted", () => {
    expect(sql).toMatch(/alter table public\.agent_settings enable row level security;/);
    expect(sql).toMatch(/revoke all on public\.agent_settings from anon, authenticated;/);
    expect(sql).toMatch(/grant all on public\.agent_settings to service_role;/);
  });
});
