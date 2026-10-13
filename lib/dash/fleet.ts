import { db } from "../db";
import { listIdentities, type IdentityRow } from "../roles";
import { scopesForRole } from "../scopes";
import type { TaskStatus } from "../types";

// B-OVERVIEW data layer (§18): /dashboard overview + /dashboard/fleet. Server-only (service role).
// Pure helpers at the top are unit-tested in tests/dash-overview.test.ts.

export const ONLINE_WINDOW_MS = 5 * 60 * 1000;
export const TASK_STATUSES: readonly TaskStatus[] = ["open", "claimed", "blocked", "done", "failed", "cancelled"] as const;

type Seen = Pick<IdentityRow, "last_heartbeat_at" | "last_used_at">;

function ms(at: string | null | undefined): number | null {
  if (!at) return null;
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
}

// Latest of heartbeat / last token use, or null when the identity was never seen.
export function lastSeen(row: Seen): string | null {
  const h = ms(row.last_heartbeat_at);
  const u = ms(row.last_used_at);
  if (h === null && u === null) return null;
  return (h ?? -Infinity) >= (u ?? -Infinity) ? row.last_heartbeat_at : row.last_used_at;
}

// Online = heartbeat OR last token use within the last 5 minutes (future timestamps from clock skew count).
export function isOnline(row: Seen & { revoked?: boolean }, now: number = Date.now()): boolean {
  if (row.revoked) return false;
  const t = ms(lastSeen(row));
  return t !== null && now - t < ONLINE_WINDOW_MS;
}

export type FleetStatus = "online" | "offline" | "revoked";

export function fleetStatus(row: Seen & { revoked: boolean }, now: number = Date.now()): FleetStatus {
  if (row.revoked) return "revoked";
  return isOnline(row, now) ? "online" : "offline";
}

export function ident(row: { agent: string; machine: string }): string {
  return row.machine ? `${row.agent}@${row.machine}` : row.agent;
}

// Live = has a non-revoked token on a non-revoked device (listIdentities also returns role-only rows).
export function liveIdentities<T extends { revoked: boolean }>(rows: T[]): T[] {
  return rows.filter((r) => !r.revoked);
}

// Online first, then most recently seen, then name. Stable for identical inputs.
export function sortFleet<T extends Seen & { revoked: boolean; agent: string; machine: string }>(rows: T[], now: number = Date.now()): T[] {
  const rank = (r: T) => (r.revoked ? 2 : isOnline(r, now) ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (ms(lastSeen(b)) ?? -Infinity) - (ms(lastSeen(a)) ?? -Infinity) ||
      ident(a).localeCompare(ident(b)),
  );
}

export interface ScopeSummary {
  read: string;
  write: string;
  inboxOnly: boolean;
  grants: string[];
  // members also read `project/<x>/*` for tasks assigned to them; that part is per request, not shown as patterns
  plusAssigned: boolean;
}

function patterns(p: string[]): string {
  return p.includes("*") ? "everything" : p.join(", ");
}

// §11 scopes for the identity's role (incl. the restricted-agent cap) + its confidential grants (§12).
export function scopeSummary(row: Pick<IdentityRow, "agent" | "role" | "grants">): ScopeSummary {
  const s = scopesForRole(row.agent, row.role, []);
  return {
    read: patterns(s.readNs),
    write: patterns(s.writeNs),
    inboxOnly: s.inboxOnly,
    grants: [...row.grants].sort(),
    plusAssigned: !s.readNs.includes("*"),
  };
}

// ------------------------------------------------------------------ server data

// Section result: a failed section renders an inline error card; the rest of the page still works.
export type Section<T> = { ok: true; data: T } | { ok: false; code: string };

function errCode(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" && c ? c : "UNKNOWN";
}

async function section<T>(name: string, fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    const code = errCode(e);
    console.error("[hub] dash section failed", name, code);
    return { ok: false, code };
  }
}

function must<T>(r: { data: T; error: { code?: string } | null }): T {
  if (r.error) throw r.error;
  return r.data;
}

function mustCount(r: { count: number | null; error: { code?: string } | null }): number {
  if (r.error) throw r.error;
  return r.count ?? 0;
}

export type FleetRow = IdentityRow & {
  ident: string;
  status: FleetStatus;
  last_seen: string | null;
  task_title: string | null;
  scope: ScopeSummary;
};

async function taskTitles(ids: string[]): Promise<Map<string, string>> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return new Map();
  const rows = must(await db().from("tasks").select("id, title").in("id", uniq)) as Array<{ id: string; title: string }>;
  return new Map(rows.map((r) => [r.id, r.title]));
}

// Every identity (live first), joined with its current task title. Throws on DB error (fleet page error.tsx).
export async function loadFleet(now: number = Date.now()): Promise<FleetRow[]> {
  const ids = await listIdentities();
  const titles = await taskTitles(ids.map((r) => r.current_task_id ?? ""));
  return sortFleet(ids, now).map((r) => ({
    ...r,
    ident: ident(r),
    status: fleetStatus(r, now),
    last_seen: lastSeen(r),
    task_title: r.current_task_id ? (titles.get(r.current_task_id) ?? null) : null,
    scope: scopeSummary(r),
  }));
}

export interface PendingApproval {
  id: string;
  question: string;
  requested_by: string;
  created_at: string;
  task_title: string | null;
}

export interface RedAlert {
  id: string;
  rule: string;
  value: string;
  created_at: string;
  device_id: string | null;
  machine: string | null;
  agent: string | null;
  token_prefix: string | null;
}

export interface BoardTask {
  id: string;
  title: string;
  namespace: string;
  status: TaskStatus;
  claimed_by_agent: string | null;
  handoff_to: string | null;
  lease_expires_at: string | null;
  created_at: string;
}

export interface Overview {
  fleet: Section<{ rows: FleetRow[]; live: number; online: number }>;
  claimedNow: Section<number>;
  memories: Section<number>;
  approvals: Section<{ total: number; rows: PendingApproval[] }>;
  inbox: Section<number>;
  alerts: Section<{ total: number; rows: RedAlert[] }>;
  board: Section<{ counts: Record<TaskStatus, number>; newest: BoardTask[] }>;
}

const NEEDS_LIMIT = 5;

export async function loadOverview(now: number = Date.now()): Promise<Overview> {
  const s = db();
  const [fleet, claimedNow, memories, approvals, inbox, alerts, board] = await Promise.all([
    section("fleet", async () => {
      const rows = await loadFleet(now);
      const live = liveIdentities(rows);
      return { rows, live: live.length, online: live.filter((r) => r.status === "online").length };
    }),
    section("claimed", async () => mustCount(await s.from("tasks").select("id", { count: "exact", head: true }).eq("status", "claimed"))),
    section("memories", async () => mustCount(await s.from("memories").select("id", { count: "exact", head: true }).is("deleted_at", null))),
    section("approvals", async () => {
      const r = await s
        .from("approvals")
        .select("id, question, requested_by, created_at, task_id", { count: "exact" })
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(NEEDS_LIMIT);
      const rows = must(r) as Array<{ id: string; question: string; requested_by: string; created_at: string; task_id: string | null }>;
      const titles = await taskTitles(rows.map((a) => a.task_id ?? ""));
      return {
        total: r.count ?? rows.length,
        rows: rows.map((a) => ({
          id: a.id,
          question: a.question,
          requested_by: a.requested_by,
          created_at: a.created_at,
          task_title: a.task_id ? (titles.get(a.task_id) ?? null) : null,
        })),
      };
    }),
    section("inbox", async () =>
      mustCount(
        await s
          .from("memories")
          .select("id", { count: "exact", head: true })
          .eq("namespace", "shared/inbox")
          .eq("review_status", "pending")
          .is("deleted_at", null),
      ),
    ),
    section("alerts", async () => {
      const res = await s
        .from("alerts")
        .select("id, rule, value, created_at, device_id, token_id", { count: "exact" })
        .eq("status", "open")
        .eq("severity", "red")
        .order("created_at", { ascending: false })
        .limit(NEEDS_LIMIT);
      const rows = must(res) as Array<{ id: string; rule: string; value: string; created_at: string; device_id: string | null; token_id: string | null }>;
      const devIds = Array.from(new Set(rows.map((a) => a.device_id).filter((x): x is string => !!x)));
      const tokIds = Array.from(new Set(rows.map((a) => a.token_id).filter((x): x is string => !!x)));
      const [devs, toks] = await Promise.all([
        devIds.length ? s.from("devices").select("id, machine_name").in("id", devIds) : Promise.resolve({ data: [], error: null }),
        // never token_hash
        tokIds.length ? s.from("agent_tokens").select("id, agent, token_prefix").in("id", tokIds) : Promise.resolve({ data: [], error: null }),
      ]);
      const machine = new Map((must(devs) as Array<{ id: string; machine_name: string }>).map((d) => [d.id, d.machine_name]));
      const tok = new Map((must(toks) as Array<{ id: string; agent: string; token_prefix: string }>).map((t) => [t.id, t]));
      const out: RedAlert[] = rows.map((a) => ({
        id: a.id,
        rule: a.rule,
        value: a.value,
        created_at: a.created_at,
        device_id: a.device_id,
        machine: a.device_id ? (machine.get(a.device_id) ?? null) : null,
        agent: a.token_id ? (tok.get(a.token_id)?.agent ?? null) : null,
        token_prefix: a.token_id ? (tok.get(a.token_id)?.token_prefix ?? null) : null,
      }));
      return { total: res.count ?? out.length, rows: out };
    }),
    section("board", async () => {
      const heads = await Promise.all(
        TASK_STATUSES.map((st) => s.from("tasks").select("id", { count: "exact", head: true }).eq("status", st)),
      );
      const counts = { open: 0, claimed: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 } as Record<TaskStatus, number>;
      TASK_STATUSES.forEach((st, i) => (counts[st] = mustCount(heads[i])));
      const newest = must(
        await s
          .from("tasks")
          .select("id, title, namespace, status, claimed_by_agent, handoff_to, lease_expires_at, created_at")
          .in("status", ["open", "claimed", "blocked"])
          .order("created_at", { ascending: false })
          .limit(3),
      ) as BoardTask[];
      return { counts, newest };
    }),
  ]);
  return { fleet, claimedNow, memories, approvals, inbox, alerts, board };
}

// Alert status transitions the overview actions need (lib/access.ts only has trust/dismiss).
export async function markAlert(alertId: string, status: "rotated" | "disabled"): Promise<void> {
  const { error } = await db().from("alerts").update({ status, read_at: new Date().toISOString() }).eq("id", alertId).eq("status", "open");
  if (error) throw error;
}

export async function alertDevice(alertId: string): Promise<string | null> {
  const row = must(await db().from("alerts").select("device_id").eq("id", alertId).maybeSingle()) as { device_id: string | null } | null;
  if (!row) throw Object.assign(new Error("alert not found"), { code: "NOT_FOUND" });
  return row.device_id;
}
