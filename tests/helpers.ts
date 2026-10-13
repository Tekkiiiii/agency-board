// Shared test helpers. Every row created by a test file is tagged with that file's runId
// (namespace `*/test-<runId>*` or `project/t<runId>*`, machine `test-<runId>-*`, confidential project
// slug `t<runId>*`, or a token minted here) and removed by cleanup().
//
// MVP-b0: tokens are identity only. Role, grants and scopes are resolved per request by
// authenticateToken (rpc hub_resolve_token), so after setRoleFor/grantFor always build a FRESH ctx.
import { db } from "../lib/db";
import { newAgentToken, authenticateToken } from "../lib/auth";
import { getFlags } from "../lib/flags";
import { LEAD_AGENTS } from "../lib/config";
import type { AgentCtx, AgentId, Role } from "../lib/types";
import { appendFileSync } from "node:fs";

export const runId = (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toLowerCase();
export const ns = (root: string, sub?: string) => `${root}/test-${runId}${sub ? `/${sub}` : ""}`;
export const machineName = (suffix = "mac") => `test-${runId}-${suffix}`;
export const identOf = (agent: AgentId, suffix = "mac") => `${agent}@${machineName(suffix)}`;
/** Test confidential project slug + namespace root. */
export const projSlug = (suffix = "") => `t${runId}${suffix ? `-${suffix}` : ""}`;

// Safety net: record this file's runId so tests/global-setup.ts can sweep it even if the file's own
// afterAll(cleanup) never completed (hook timeout mid-cleanup, killed worker, beforeAll threw early).
// Only runIds registered by THIS vitest invocation are ever swept; other runs' rows are never touched.
if (process.env.AGENCY_BOARD_TEST_RUNS_FILE) {
  try { appendFileSync(process.env.AGENCY_BOARD_TEST_RUNS_FILE, runId + "\n"); } catch { /* best effort */ }
}

const tokenIds: string[] = [];
export function trackToken(id: string) { tokenIds.push(id); }

async function deviceFor(machine: string): Promise<string> {
  const { data: found, error: e1 } = await db().from("devices").select("id").eq("machine_name", machine).maybeSingle();
  if (e1) throw e1;
  if (found) return found.id as string;
  const { data, error } = await db().from("devices").insert({ machine_name: machine, os: "mac" }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

// No read_ns/write_ns/inbox_only: those columns are being dropped (migration ...0003).
export async function mintToken(agent: AgentId, opts: { machine?: string } = {}) {
  const machine = machineName(opts.machine);
  const deviceId = await deviceFor(machine);
  const t = newAgentToken(agent);
  const { data, error } = await db().from("agent_tokens").insert({
    agent, device_id: deviceId, token_hash: t.hash, token_prefix: t.prefix,
  }).select("id").single();
  if (error) throw error;
  trackToken(data.id as string);
  return { raw: t.raw, tokenId: data.id as string, deviceId, machine, ident: `${agent}@${machine}` };
}

export async function ctxFor(raw: string): Promise<AgentCtx> {
  const base = await authenticateToken(raw);
  if (!base) throw new Error("ctxFor: token did not authenticate");
  return { ...base, flags: await getFlags(), route: "test" } as AgentCtx;
}

/** Handler-level director checks without touching the real director row (claude@laptop). */
export function asDirector(ctx: AgentCtx): AgentCtx {
  return { ...ctx, role: "director", readNs: ["*"], writeNs: ["*"], inboxOnly: false } as AgentCtx;
}

async function rpcSetRole(agent: string, deviceId: string, role: Role) {
  const { data, error } = await db().rpc("hub_set_role", { p_agent: agent, p_device: deviceId, p_role: role, p_lead_agents: [...LEAD_AGENTS] });
  if (error) throw error;
  return data as { agent: AgentId; device_id: string; role: Role; demoted: string | null };
}

/** hub_set_role for 'lead' | 'member'. Director promotion only via withTestDirector (it demotes the real one). */
export async function setRoleFor(agent: AgentId, deviceId: string, role: Exclude<Role, "director">) {
  if ((role as Role) === "director") throw new Error("use withTestDirector() to promote a test identity");
  return rpcSetRole(agent, deviceId, role);
}

/**
 * Promote a TEST identity to director against the live DB, run fn, then ALWAYS restore the original
 * director (read first from agent_roles) and delete the audit rows the restore wrote for it.
 */
export async function withTestDirector<T>(
  agent: AgentId, deviceId: string,
  fn: (p: { promoted: Awaited<ReturnType<typeof rpcSetRole>>; original: { agent: string; device_id: string } | null }) => Promise<T>,
): Promise<T> {
  const d = db();
  const { data: orig, error } = await d.from("agent_roles").select("agent, device_id").eq("role", "director").maybeSingle();
  if (error) throw error;
  const { data: last } = await d.from("admin_audit").select("id").order("id", { ascending: false }).limit(1).maybeSingle();
  const auditFloor = (last?.id as number | undefined) ?? 0;
  try {
    const promoted = await rpcSetRole(agent, deviceId, "director");
    return await fn({ promoted, original: orig ?? null });
  } finally {
    if (orig) {
      await rpcSetRole(orig.agent, orig.device_id, "director"); // demotes the test identity back to lead
      const { data: dev } = await d.from("devices").select("machine_name").eq("id", orig.device_id).maybeSingle();
      const realTarget = dev?.machine_name ? `${orig.agent}@${dev.machine_name}` : orig.agent;
      await del(d.from("admin_audit").delete().gt("id", auditFloor).eq("action", "role_set").eq("target", realTarget));
    } else {
      await rpcSetRole(agent, deviceId, "lead");
    }
  }
}

export async function grantFor(agent: AgentId, deviceId: string, slug: string, granted = true): Promise<boolean> {
  const { data, error } = await db().rpc("hub_set_grant", { p_agent: agent, p_device: deviceId, p_slug: slug, p_granted: granted });
  if (error) throw error;
  return data === true;
}

/** Creates confidential project `t<runId>[-suffix]`; namespace root is `project/<slug>`. */
export async function makeProject(suffix = ""): Promise<{ slug: string; name: string; ns: (sub?: string) => string }> {
  const slug = projSlug(suffix);
  const name = `Test ${slug}`;
  const { error } = await db().from("confidential_projects").insert({ slug, name });
  if (error) throw error;
  return { slug, name, ns: (sub?: string) => `project/${slug}${sub ? `/${sub}` : ""}` };
}

// Neighbour/list results may come back as an array or wrapped; normalise to an id list.
export function idsOf(r: any): string[] {
  const list = Array.isArray(r) ? r : (r?.neighbors ?? r?.nodes ?? r?.hits ?? r?.tasks ?? []);
  return list.map((x: any) => x.id);
}

// recall hits + their neighbours, flattened.
export function recallIds(res: any): string[] {
  const hits: any[] = res?.hits ?? [];
  return [...hits, ...hits.flatMap((h) => h.neighbors ?? [])].map((n) => n.id);
}

// Await a promise expected to reject with an ApiError; returns the error.
export async function apiErr(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected rejection, got success");
}

async function del(q: PromiseLike<{ error: unknown }>) {
  const { error } = await q;
  if (error) console.error("cleanup error", (error as any).code ?? error);
}

// afterAll(cleanup) passes a suite arg, so cleanup() takes none; sweepRun(id) is for the global teardown.
export function cleanup() { return sweepRun(runId); }

export async function sweepRun(forRun: string) {
  const d = db();
  const runId = forRun; // shadows the module const: sweeps exactly this run's rows
  // Covers every */test-<runId>* namespace, incl. project/acme/test-<runId>* (tier 1, not confidential) and
  // project/confidential/test-<runId>* (the seeded confidential project; its slug row is never deleted).
  const nsLike = `%/test-${runId}%`;
  const confNsLike = `project/t${runId}%`;
  const machLike = `test-${runId}-%`;
  const { data: devs } = await d.from("devices").select("id").like("machine_name", machLike);
  const deviceIds = (devs ?? []).map((r: any) => r.id as string);
  if (deviceIds.length) {
    const { data: toks } = await d.from("agent_tokens").select("id").in("device_id", deviceIds);
    for (const t of toks ?? []) if (!tokenIds.includes(t.id)) tokenIds.push(t.id);
  }
  const taskIds: string[] = [];
  for (const like of [nsLike, confNsLike]) {
    const { data: tasks } = await d.from("tasks").select("id").like("namespace", like);
    taskIds.push(...(tasks ?? []).map((r: any) => r.id as string));
  }

  if (tokenIds.length) await del(d.from("approvals").delete().in("requested_by_token", tokenIds));
  if (taskIds.length) await del(d.from("approvals").delete().in("task_id", taskIds));
  await del(d.from("tasks").delete().like("namespace", nsLike));
  await del(d.from("tasks").delete().like("namespace", confNsLike));
  if (tokenIds.length) await del(d.from("tasks").delete().in("created_by_token", tokenIds));
  if (tokenIds.length) await del(d.from("memories").delete().in("author_token", tokenIds));
  await del(d.from("memories").delete().like("namespace", nsLike));
  await del(d.from("memories").delete().like("namespace", confNsLike));
  await del(d.from("memories").delete().like("target_namespace", nsLike));
  await del(d.from("memories").delete().like("target_namespace", confNsLike));
  if (tokenIds.length) {
    await del(d.from("alerts").delete().in("token_id", tokenIds));
    await del(d.from("access_log").delete().in("token_id", tokenIds));
  }
  if (deviceIds.length) {
    await del(d.from("alerts").delete().in("device_id", deviceIds));
    await del(d.from("access_log").delete().in("device_id", deviceIds));
    // Both cascade on device delete; explicit so a failed device delete still leaves no grants/roles behind.
    await del(d.from("grants").delete().in("device_id", deviceIds));
    await del(d.from("agent_roles").delete().in("device_id", deviceIds));
  }
  await del(d.from("confidential_projects").delete().like("slug", `t${runId}%`)); // grants cascade
  await del(d.from("admin_audit").delete().like("target", `%test-${runId}%`));
  await del(d.from("admin_audit").delete().like("target", `t${runId}%`));
  if (tokenIds.length) await del(d.from("agent_tokens").delete().in("id", tokenIds));
  await del(d.from("connect_codes").delete().like("machine_name", machLike));
  if (deviceIds.length) await del(d.from("devices").delete().in("id", deviceIds)); // device_known cascades
}
