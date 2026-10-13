import { staleConfig, waitingMinutes } from "../access";
import { db } from "../db";
import { assertConfidentialTiers, tierHit, tierReadable } from "../guard";
import { confidentialSlugs, listIdentities } from "../roles";
import { ident as identOf, lastSeen } from "./fleet";
import { confSlug } from "../scopes";
import { AGENTS } from "../config";
import { ApiError, type TaskStatus } from "../types";

// B-BOARD (§18): task board + approvals reads, and the admin task mutations (reassign / cancel / retry).
// Admin sees every task, including confidential ones (they are only badged). Every mutation is a single
// UPDATE conditional on the current status, so a concurrent agent claim/complete makes it a clean 409.

/* eslint-disable @typescript-eslint/no-explicit-any */

export const BOARD_COLUMNS = ["open", "claimed", "blocked", "done", "failed"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number] | "cancelled";

/** Most recent N rows per finished column; open/claimed/blocked show up to OPEN_LIMIT (they should stay small). */
export const FINISHED_LIMIT = 50;
export const OPEN_LIMIT = 200;

const ADMIN_ACTOR = "owner";
// Agent ids are [a-z][a-z0-9]{1,23} (lib/config.ts), so they need no regex escaping.
const TARGET_RE = new RegExp(`^(${AGENTS.join("|")})(@[A-Za-z0-9._-]{1,80})?$`);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface BoardTask {
  id: string;
  namespace: string;
  title: string;
  status: TaskStatus;
  created_by: string;
  claimed_by_token: string | null;
  claimed_by_agent: string | null;
  lease_expires_at: string | null;
  attempts: number;
  handoff_to: string | null;
  assigned_by: string | null; // column from migration 0002; null when the migration is not applied
  created_at: string;
  updated_at: string | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface TaskDetail extends BoardTask {
  body: string | null;
  routed_by: string | null;
  routing_reason: string | null;
}

export interface TaskEvent {
  id: number;
  actor: string;
  kind: string;
  note: string | null;
  at: string;
}

export interface Board {
  columns: Record<BoardColumn, BoardTask[]>;
  totals: Record<BoardColumn, number>;
  /** Confidential project slugs, or null when they could not be read (migration 0002 not applied). */
  confidential: string[] | null;
}

// ---------- pure helpers (unit-tested) ----------

/** Groups tasks into board columns, keeping input order. Cancelled is its own column (shown behind a filter). */
export function groupColumns(tasks: BoardTask[]): Record<BoardColumn, BoardTask[]> {
  const out: Record<BoardColumn, BoardTask[]> = { open: [], claimed: [], blocked: [], done: [], failed: [], cancelled: [] };
  for (const t of tasks) if (t.status in out) out[t.status as BoardColumn].push(t);
  return out;
}

/** True when a claimed task's lease is in the past (the claimer is presumed dead; any agent may re-claim). */
export function leaseExpired(t: Pick<BoardTask, "status" | "lease_expires_at">, now: number = Date.now()): boolean {
  if (t.status !== "claimed" || !t.lease_expires_at) return false;
  const at = Date.parse(t.lease_expires_at);
  return Number.isFinite(at) && at < now;
}

/** "confidential: <slug>" badge text, or null. */
export function confidentialLabel(ns: string, confidential: string[] | null): string | null {
  if (!confidential) return null;
  const slug = confSlug(ns, confidential);
  return slug ? `confidential: ${slug}` : null;
}

/** Turns an ApiError / Postgres error into one readable sentence for the UI (no content echoed). */
export function readableError(e: unknown): { status: number; message: string } {
  // §13 / §13.5 tier hit (all 5 codes) from ApiError or the DB trigger (`<CODE>:<rule>`): 422, rule id only.
  const tier = tierHit(e);
  if (tier) return { status: 422, message: tierReadable(tier) };
  if (e instanceof ApiError) return { status: e.status, message: e.message };
  const pg = e as { code?: string; message?: string; issues?: unknown[] } | null;
  if (pg && Array.isArray(pg.issues)) return { status: 422, message: "Invalid input." };
  if (pg?.code && ["42703", "42P01", "PGRST204", "PGRST205"].includes(pg.code)) {
    return { status: 500, message: "The database is missing the roles and grants migration (20261007000002). Nothing was changed." };
  }
  return { status: 500, message: "Something went wrong. Nothing was changed." };
}

// ---------- stale (unclaimed) task flag ----------
// Same definition as the agent-facing alert (lib/handlers.ts staleAlerts): open + handed to somebody + waited > X
// (STALE_TASK_MIN_MINUTES, default 30). The dashboard shows it even when nobody is active, which no poll can cover.

export type StaleTask = BoardTask & { waiting_min: number };

/** Open handed-off tasks that waited longer than staleMs, longest wait first. */
export function staleTasks(tasks: BoardTask[], nowMs: number = Date.now(), staleMs: number = staleConfig().staleMs): StaleTask[] {
  return tasks
    .filter((t) => t.status === "open" && !!t.handoff_to && nowMs - Date.parse(t.updated_at ?? t.created_at) > staleMs)
    .map((t) => ({ ...t, waiting_min: waitingMinutes(t, nowMs) }))
    .sort((a, b) => b.waiting_min - a.waiting_min);
}

/** Active = non-revoked identity seen (heartbeat or token use) within activeMs (STALE_ACTIVE_MIN_MINUTES, default 10). Per agent@machine. */
export function activeIdents(
  rows: Array<{ agent: string; machine: string; revoked: boolean; last_heartbeat_at: string | null; last_used_at: string | null }>,
  nowMs: number = Date.now(),
  activeMs: number = staleConfig().activeMs,
): string[] {
  return rows
    .filter((r) => !r.revoked && lastSeen(r) !== null && nowMs - Date.parse(lastSeen(r)!) < activeMs)
    .map((r) => identOf(r))
    .sort();
}

export interface StaleSummary { count: number; watchers: string[]; nobodyActive: boolean; oldestMin: number }

/** watchers = active identities that would see at least one stale task in their poll (not its own target). */
export function staleSummary(stale: StaleTask[], active: string[]): StaleSummary {
  const isTarget = (t: StaleTask, w: string) => t.handoff_to === w || t.handoff_to === w.split("@")[0];
  const watchers = active.filter((w) => stale.some((t) => !isTarget(t, w)));
  return { count: stale.length, watchers, nobodyActive: stale.length > 0 && watchers.length === 0, oldestMin: stale[0]?.waiting_min ?? 0 };
}

/** Active identities right now; null when identities could not be read (the flag still shows, without the watcher line). */
export async function loadActiveIdents(): Promise<string[] | null> {
  try {
    return activeIdents(await listIdentities());
  } catch (e) {
    console.warn("[hub] board: active identities unavailable", String((e as { code?: unknown })?.code ?? "unknown"));
    return null;
  }
}

// ---------- reads ----------

const TASK_COLS = "*"; // `*` so the page still works before migration 0002 adds assigned_by

function toBoardTask(r: any): BoardTask {
  return {
    id: r.id,
    namespace: r.namespace,
    title: r.title,
    status: r.status,
    created_by: r.created_by,
    claimed_by_token: r.claimed_by_token ?? null,
    claimed_by_agent: r.claimed_by_agent ?? null,
    lease_expires_at: r.lease_expires_at ?? null,
    attempts: r.attempts ?? 0,
    handoff_to: r.handoff_to ?? null,
    assigned_by: r.assigned_by ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
    started_at: r.started_at ?? null,
    completed_at: r.completed_at ?? null,
  };
}

async function safeConfidential(): Promise<string[] | null> {
  try {
    return await confidentialSlugs();
  } catch (e) {
    console.warn("[hub] board: confidential slugs unavailable", String((e as { code?: unknown })?.code ?? "unknown"));
    return null;
  }
}

/** One query per column (each bounded) plus exact counts; no N+1. */
export async function loadBoard(opts: { showCancelled: boolean }): Promise<Board> {
  const cols: BoardColumn[] = opts.showCancelled ? [...BOARD_COLUMNS, "cancelled"] : [...BOARD_COLUMNS];
  const [confidential, ...results] = await Promise.all([
    safeConfidential(),
    // open: oldest first (queue order); claimed: soonest-expiring lease first; blocked: waiting longest first
    // (it needs a human or the routed agent; no lease); finished: most recent first.
    ...cols.map((c) => {
      const q = db().from("tasks").select(TASK_COLS, { count: "exact" }).eq("status", c);
      if (c === "open") return q.order("created_at", { ascending: true }).limit(OPEN_LIMIT);
      if (c === "claimed") return q.order("lease_expires_at", { ascending: true, nullsFirst: false }).limit(OPEN_LIMIT);
      if (c === "blocked") return q.order("updated_at", { ascending: true, nullsFirst: false }).limit(OPEN_LIMIT);
      return q.order("updated_at", { ascending: false, nullsFirst: false }).limit(FINISHED_LIMIT);
    }),
  ]);
  const columns: Record<BoardColumn, BoardTask[]> = { open: [], claimed: [], blocked: [], done: [], failed: [], cancelled: [] };
  const totals: Record<BoardColumn, number> = { open: 0, claimed: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 };
  cols.forEach((c, i) => {
    const r = results[i] as { data: any[] | null; error: unknown; count: number | null };
    if (r.error) throw r.error;
    columns[c] = (r.data ?? []).map(toBoardTask);
    totals[c] = r.count ?? columns[c].length;
  });
  // Cancelled count is shown on the filter toggle even when the column is hidden.
  if (!opts.showCancelled) {
    const { count, error } = await db().from("tasks").select("id", { count: "exact", head: true }).eq("status", "cancelled");
    if (error) throw error;
    totals.cancelled = count ?? 0;
  }
  return { columns, totals, confidential };
}

/** Task + its full event history (oldest first). Null when the id is unknown or malformed. */
export async function loadTaskDetail(id: string): Promise<{ task: TaskDetail; events: TaskEvent[] } | null> {
  if (!UUID_RE.test(id)) return null;
  const [t, ev] = await Promise.all([
    db().from("tasks").select(TASK_COLS).eq("id", id).maybeSingle(),
    db().from("task_events").select("id, actor, kind, note, at").eq("task_id", id).order("at", { ascending: true }).order("id", { ascending: true }).limit(500),
  ]);
  if (t.error) throw t.error;
  if (ev.error) throw ev.error;
  if (!t.data) return null;
  const r: any = t.data;
  return {
    task: { ...toBoardTask(r), body: r.body ?? null, routed_by: r.routed_by ?? null, routing_reason: r.routing_reason ?? null },
    events: (ev.data ?? []) as TaskEvent[],
  };
}

export interface ReassignTarget {
  value: string; // handoff_to value: `agent` or `agent@machine`
  label: string;
}

/**
 * Valid reassign targets: every non-revoked identity (agent@machine) from listIdentities(), plus the bare
 * agents (= any machine of that agent). `identitiesOk=false` when identities could not be read (migration
 * 0002 not applied): then only bare agents are offered.
 */
export async function reassignTargets(): Promise<{ targets: ReassignTarget[]; identitiesOk: boolean }> {
  const bare: ReassignTarget[] = AGENTS.map((a) => ({ value: a, label: `${a} (any machine)` }));
  try {
    const ids = await listIdentities();
    const named = ids
      .filter((i) => !i.revoked && i.machine)
      .map((i) => ({ value: `${i.agent}@${i.machine}`, label: `${i.agent}@${i.machine} · ${i.role}` }))
      .filter((t) => TARGET_RE.test(t.value));
    const seen = new Set<string>();
    const uniq = named.filter((t) => (seen.has(t.value) ? false : (seen.add(t.value), true)));
    return { targets: [...uniq, ...bare], identitiesOk: true };
  } catch (e) {
    console.warn("[hub] board: identities unavailable", String((e as { code?: unknown })?.code ?? "unknown"));
    return { targets: bare, identitiesOk: false };
  }
}

export interface ApprovalRow {
  id: string;
  task_id: string | null;
  requested_by: string;
  question: string;
  options: string[];
  status: "pending" | "approved" | "denied" | "expired";
  answer: string | null;
  decided_at: string | null;
  /** 'owner' (admin/dashboard) or the director identity (agent@machine) for `review` decisions (§13.4). */
  decided_by: string | null;
  created_at: string;
  task_title: string | null;
  task_namespace: string | null;
}

function toOptions(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 10);
}

/** Pending approvals (oldest first, the most overdue on top) and the last 50 decided ones, with linked task titles. */
export async function loadApprovals(): Promise<{ pending: ApprovalRow[]; decided: ApprovalRow[]; confidential: string[] | null }> {
  const cols = "id, task_id, requested_by, question, options, status, answer, decided_at, decided_by, created_at";
  const [confidential, p, d] = await Promise.all([
    safeConfidential(),
    db().from("approvals").select(cols).eq("status", "pending").order("created_at", { ascending: true }).limit(200),
    db().from("approvals").select(cols).neq("status", "pending").order("decided_at", { ascending: false, nullsFirst: false }).limit(FINISHED_LIMIT),
  ]);
  if (p.error) throw p.error;
  if (d.error) throw d.error;
  const rows = [...(p.data ?? []), ...(d.data ?? [])] as any[];
  const taskIds = Array.from(new Set(rows.map((r) => r.task_id).filter(Boolean))) as string[];
  const tasks = new Map<string, { title: string; namespace: string }>();
  if (taskIds.length) {
    const { data, error } = await db().from("tasks").select("id, title, namespace").in("id", taskIds);
    if (error) throw error;
    for (const t of (data ?? []) as any[]) tasks.set(t.id, { title: t.title, namespace: t.namespace });
  }
  const map = (r: any): ApprovalRow => ({
    id: r.id,
    task_id: r.task_id ?? null,
    requested_by: r.requested_by,
    question: r.question,
    options: toOptions(r.options),
    status: r.status,
    answer: r.answer ?? null,
    decided_at: r.decided_at ?? null,
    decided_by: r.decided_by ?? null,
    created_at: r.created_at,
    task_title: r.task_id ? (tasks.get(r.task_id)?.title ?? null) : null,
    task_namespace: r.task_id ? (tasks.get(r.task_id)?.namespace ?? null) : null,
  });
  return { pending: (p.data ?? []).map(map), decided: (d.data ?? []).map(map), confidential };
}

// ---------- admin mutations ----------

const RELEASE = { claimed_by_token: null, claimed_by_agent: null, lease_expires_at: null };

const REASSIGNABLE: TaskStatus[] = ["open", "claimed", "blocked", "failed", "cancelled"];
const CANCELLABLE: TaskStatus[] = ["open", "claimed", "blocked", "failed"];
const RETRYABLE: TaskStatus[] = ["failed", "cancelled"];

function vId(id: string): string {
  if (!UUID_RE.test(id)) throw new ApiError(422, "VALIDATION", "Invalid task id.");
  return id.toLowerCase();
}

/** Conditional update; on 0 rows explains why (404 or 409 with the current status). */
async function guardedUpdate(id: string, allowed: TaskStatus[], patch: Record<string, unknown>, verb: string): Promise<{ before: any; after: BoardTask }> {
  const { data: before, error: e0 } = await db().from("tasks").select("id, status, claimed_by_token").eq("id", id).maybeSingle();
  if (e0) throw e0;
  if (!before) throw new ApiError(404, "NOT_FOUND", "Task not found.");
  const { data, error } = await db()
    .from("tasks")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .in("status", allowed)
    .select(TASK_COLS);
  if (error) throw error;
  if (!data?.length) {
    const { data: cur } = await db().from("tasks").select("status").eq("id", id).maybeSingle();
    const status = (cur as { status?: string } | null)?.status ?? before.status;
    throw new ApiError(409, "CONFLICT", `Cannot ${verb}: the task is ${status} now. Refresh and try again.`);
  }
  return { before, after: toBoardTask(data[0]) };
}

async function addEvent(taskId: string, kind: "handoff" | "cancelled" | "retried", note: string | null): Promise<void> {
  const { error } = await db().from("task_events").insert({ task_id: taskId, actor: ADMIN_ACTOR, kind, note });
  if (error) throw error;
}

/** The previous claimer no longer works on this task: clear its heartbeat pointer (only if it still points here). */
async function clearCurrentTask(tokenId: string | null, taskId: string): Promise<void> {
  if (!tokenId) return;
  const { error } = await db().from("agent_tokens").update({ current_task_id: null }).eq("id", tokenId).eq("current_task_id", taskId);
  if (error) console.error("[hub] board: clear current task failed", String(error.code ?? "unknown"));
}

/**
 * Reassign: handoff_to = target, status open, claim cleared, assigned_by = 'owner', event 'handoff'.
 * A blocked task (no lease, routed back to someone) reopens for the new target the same way. notify_pending is
 * deliberately not written here: the inbox only surfaces it on done/failed rows and hub_claim clears it.
 * `allowedTargets` (from reassignTargets) is re-checked here so a forged form value is rejected.
 */
export async function reassignTask(id: string, target: string, allowedTargets: string[]): Promise<BoardTask> {
  const taskId = vId(id);
  if (!TARGET_RE.test(target) || !allowedTargets.includes(target)) {
    throw new ApiError(422, "VALIDATION", "Pick an agent or identity from the list.");
  }
  // §13: the target lands in tasks.handoff_to and the event note; check before the update (not half-applied).
  assertConfidentialTiers({ ok: false }, target); // no namespace: contracts only with a confidential marker (TARGET_RE allows none)
  const { before, after } = await guardedUpdate(
    taskId,
    REASSIGNABLE,
    { status: "open", handoff_to: target, assigned_by: ADMIN_ACTOR, ...RELEASE, completed_at: null, completion_key: null },
    "reassign",
  );
  await addEvent(taskId, "handoff", `to ${target} (reassigned from dashboard)`);
  await clearCurrentTask(before.claimed_by_token, taskId);
  return after;
}

/** Cancel: status cancelled, lease cleared, event 'cancelled'. */
export async function cancelTask(id: string): Promise<BoardTask> {
  const taskId = vId(id);
  const { before, after } = await guardedUpdate(taskId, CANCELLABLE, { status: "cancelled", ...RELEASE }, "cancel");
  await addEvent(taskId, "cancelled", null);
  await clearCurrentTask(before.claimed_by_token, taskId);
  return after;
}

/** Retry: failed/cancelled -> open, attempts kept, claim + completion cleared, event 'retried'. */
export async function retryTask(id: string): Promise<BoardTask> {
  const taskId = vId(id);
  const { after } = await guardedUpdate(taskId, RETRYABLE, { status: "open", ...RELEASE, completed_at: null, completion_key: null }, "retry");
  await addEvent(taskId, "retried", null);
  return after;
}
