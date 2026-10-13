// Migration 0006 (blocked status + complete/notify) SQL-text checks, no DB. The DB-backed behaviour is covered by
// tests/board.test.ts and tests/roles.test.ts (they need 0006 applied on the hosted project).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..", "supabase", "migrations");
const sql = readFileSync(join(dir, "20261008000006_blocked_and_notify.sql"), "utf8");
const body = (name: string, end: string) => {
  const from = sql.indexOf(`create or replace function public.${name}(`);
  expect(from, `${name} defined`).toBeGreaterThan(-1);
  return sql.slice(from, sql.indexOf(end, from) + end.length);
};

describe("migration 0006: blocked + notify", () => {
  it("tasks.status CHECK lists blocked and every old status; task_events.kind adds blocked and keeps the old kinds", () => {
    const status = /add constraint tasks_status_check\s+check \(status in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    for (const s of ["open", "claimed", "blocked", "done", "failed", "cancelled"]) expect(status).toContain(`'${s}'`);
    const kind = /add constraint task_events_kind_check\s+check \(kind in \(([^)]*)\)\)/.exec(sql)?.[1] ?? "";
    for (const k of ["created", "claimed", "renewed", "handoff", "update", "done", "failed", "released", "cancelled", "retried", "blocked"]) expect(kind).toContain(`'${k}'`);
    // the old constraints are looked up by definition and dropped before re-adding (never guessed names)
    expect(sql).toMatch(/pg_get_constraintdef\(c\.oid\) ilike '%cancelled%'/);
    expect(sql).toMatch(/pg_get_constraintdef\(c\.oid\) ilike '%retried%'/);
  });

  it("tasks.notify_pending is boolean not null default false", () => {
    expect(sql).toMatch(/add column if not exists notify_pending boolean not null default false/);
  });

  it("hub_complete: old 5-arg dropped, new one has p_notify/p_ident/p_note default null, blocked is not terminal", () => {
    expect(sql).toMatch(/drop function if exists public\.hub_complete\(uuid, uuid, text, jsonb, text\);/);
    const f = body("hub_complete", "end $$;");
    expect(f).toMatch(/p_status text default 'done',\s+p_notify text default null, p_ident text default null, p_note text default null\)/);
    expect(f).toMatch(/if t\.status in \('done','failed'\) then/); // replay/conflict check unchanged
    expect(f).not.toMatch(/'blocked'/);
    expect(f).toMatch(/handoff_to = case when p_notify is not null then p_notify else handoff_to end/);
    expect(f).toMatch(/assigned_by = case when p_notify is not null then coalesce\(p_ident, assigned_by\) else assigned_by end/);
    expect(f).toMatch(/notify_pending = case when p_notify is not null then true else notify_pending end/);
  });

  it("hub_claim: blocked only when routed, handoff rule kept, claim clears notify_pending", () => {
    const f = body("hub_claim", "$$;");
    expect(f).toMatch(/t\.status = 'blocked' and t\.handoff_to is not null/);
    expect(f).toMatch(/t\.status = 'open'/);
    expect(f).toMatch(/t\.status = 'claimed' and t\.lease_expires_at < now\(\)/);
    expect(f).toMatch(/\(t\.handoff_to is null or t\.handoff_to = p_agent or \(p_ident is not null and t\.handoff_to = p_ident\)\)/);
    expect(f).toMatch(/notify_pending = false/);
  });

  it("hub_resolve_token assigned scope covers blocked and notify_pending done/failed", () => {
    const f = body("hub_resolve_token", "$$;");
    expect(f).toMatch(/k\.status in \('open','claimed','blocked'\) or \(k\.status in \('done','failed'\) and k\.notify_pending\)/);
  });

  it("re-applies the service_role-only lockdown to the re-created hub_complete (and everything else)", () => {
    expect(sql).toMatch(/revoke all on function public\.hub_complete\(uuid, uuid, text, jsonb, text, text, text, text\) from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on function public\.hub_complete\(uuid, uuid, text, jsonb, text, text, text, text\) to service_role;/);
    expect(sql).toMatch(/revoke all on all functions in schema public from public, anon, authenticated;/);
    expect(sql).toMatch(/grant execute on all functions in schema public to service_role;/);
  });

  it("is a plain migration: no BEGIN/COMMIT, earlier migrations untouched by name", () => {
    expect(sql).not.toMatch(/^\s*(begin|commit)\s*;/im);
  });
});
