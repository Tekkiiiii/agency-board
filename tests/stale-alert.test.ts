import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { db } from "../lib/db";
import { setFlags } from "../lib/flags";
import { staleAlertText, staleConfig, waitingMinutes } from "../lib/access";
import { postTask, listTasks, claimTask, heartbeat, completeTask, updateTask, inbox, inboxText } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, cleanup, makeProject } from "./helpers";

// Unclaimed-task ("stale task") alert: notify only (R2/R3 unchanged), lazy piggyback on list_tasks + inbox.
// X (STALE_TASK_MIN_MINUTES) defaults to 30 min. Dedupe = task_events (actor=poller ident, kind=update, note=stale-alert).

describe("stale alert pure helpers", () => {
  it("staleConfig: defaults 30 / 10 min, env-injectable, junk falls back", () => {
    expect(staleConfig({})).toEqual({ staleMs: 30 * 60_000, activeMs: 10 * 60_000 });
    expect(staleConfig({ STALE_TASK_MIN_MINUTES: "1", STALE_ACTIVE_MIN_MINUTES: "2" })).toEqual({ staleMs: 60_000, activeMs: 120_000 });
    expect(staleConfig({ STALE_TASK_MIN_MINUTES: "0.5" }).staleMs).toBe(30_000);
    for (const bad of ["", "abc", "-5", "0", "NaN"]) expect(staleConfig({ STALE_TASK_MIN_MINUTES: bad }).staleMs).toBe(30 * 60_000);
  });
  it("waitingMinutes floors, never negative, falls back to created_at", () => {
    const now = Date.parse("2026-10-13T10:00:00Z");
    expect(waitingMinutes({ updated_at: "2026-10-13T09:29:00Z", created_at: "2026-10-13T01:00:00Z" }, now)).toBe(31);
    expect(waitingMinutes({ updated_at: null, created_at: "2026-10-13T09:00:30Z" }, now)).toBe(59);
    expect(waitingMinutes({ updated_at: "2026-10-13T10:05:00Z", created_at: "2026-10-13T10:05:00Z" }, now)).toBe(0);
  });
  it("staleAlertText: exact wording, untrusted title cleaned (control chars, quotes, brackets, 120 chars)", () => {
    expect(staleAlertText({ handoff_to: "codex@m2", title: "Fix the thing" }, 31)).toBe("unclaimed task for codex@m2: Fix the thing, waiting 31 min");
    const t = staleAlertText({ handoff_to: "codex", title: 'a"b\\c[d]{e}\n\u0007' + "x".repeat(300) }, 5);
    expect(t).not.toMatch(/["\\\[\]{}\n\u0007]/);
    expect(t.length).toBeLessThan(200);
    expect(t.startsWith("unclaimed task for codex: a b c d e")).toBe(true);
  });
});

let poster: AgentCtx, target: AgentCtx, watcher: AgentCtx, watcher2: AgentCtx;
let targetRaw: string, watcherRaw: string;
const MIN = 60_000;

beforeAll(async () => {
  poster = await ctxFor((await mintToken("claude", { machine: "m1" })).raw);
  targetRaw = (await mintToken("codex", { machine: "m2" })).raw;
  target = await ctxFor(targetRaw);
  watcherRaw = (await mintToken("claude", { machine: "m3" })).raw;
  watcher = await ctxFor(watcherRaw);
  watcher2 = await ctxFor((await mintToken("claude", { machine: "m4" })).raw);
});

afterEach(async () => {
  // Isolation: each test starts without leftover open tasks (peek returns the oldest 5, so stragglers would crowd it).
  await db().from("tasks").delete().like("namespace", `%/test-${runId}%`);
  await setFlags({ dispatchPaused: false, writesFrozen: false });
  delete process.env.STALE_TASK_MIN_MINUTES;
});
afterAll(async () => {
  await setFlags({ dispatchPaused: false, writesFrozen: false });
  await cleanup();
});

let n = 0;
async function stale(over: Record<string, unknown> = {}, ageMin = 31, namespace = ns("project")): Promise<{ id: string; title: string }> {
  const title = `stale ${runId} ${++n}`;
  const t: any = await postTask(poster, { namespace, title, handoff_to: target.ident, ...over } as any);
  await db().from("tasks").update({ updated_at: new Date(Date.now() - ageMin * MIN).toISOString() }).eq("id", t.id);
  return { id: t.id, title };
}
const alertsOf = (r: any): string[] => (r.stale_alerts ?? []).filter((a: string) => a.includes(String(runId)));
const taskRow = async (id: string) => (await db().from("tasks").select("*").eq("id", id).single()).data as any;
const events = async (id: string) =>
  ((await db().from("task_events").select("actor, kind, note").eq("task_id", id).eq("note", "stale-alert")).data ?? []) as any[];

describe("list_tasks carries the stale alert", () => {
  it("a fresh handed-off task (under X) raises nothing, and the key is absent (reply shape unchanged)", async () => {
    await stale({}, 5);
    const r: any = await listTasks(watcher, {});
    expect(alertsOf(r)).toEqual([]);
    expect(r.stale_alerts === undefined || r.stale_alerts.length > 0).toBe(true); // never an empty array
  });

  it("a task waiting > X min: another identity's poll carries 'unclaimed task for <Y>: <title>, waiting N min'", async () => {
    const t = await stale({}, 31);
    const r: any = await listTasks(watcher, { mine: true, status: "open" });
    const a = alertsOf(r).filter((x) => x.includes(t.title));
    expect(a).toHaveLength(1);
    expect(a[0]).toBe(`unclaimed task for ${target.ident}: ${t.title}, waiting 31 min`);
  });

  it("dedupe: once per agent per task; a second identity still gets its own one", async () => {
    const t = await stale();
    const first: any = await listTasks(watcher, {});
    expect(alertsOf(first).some((x) => x.includes(t.title))).toBe(true);
    const second: any = await listTasks(watcher, {});
    expect(alertsOf(second).some((x) => x.includes(t.title))).toBe(false);
    const other: any = await listTasks(watcher2, {});
    expect(alertsOf(other).some((x) => x.includes(t.title))).toBe(true);
    expect((await events(t.id)).map((e) => e.actor).sort()).toEqual([watcher.ident, watcher2.ident].sort());
    expect((await events(t.id))[0]).toMatchObject({ kind: "update", note: "stale-alert" });
  });

  it("excludes Y's own inbox entry (handed to the poller by ident or by bare agent)", async () => {
    const t = await stale();
    const own: any = await listTasks(target, { mine: true, status: "open" });
    expect(alertsOf(own).some((x) => x.includes(t.title))).toBe(false);
    expect(own.tasks.some((x: any) => x.id === t.id)).toBe(true); // still in its normal list
    const bare = await stale({ handoff_to: "codex" });
    const asCodex: any = await listTasks(target, {});
    expect(alertsOf(asCodex).some((x) => x.includes(bare.title))).toBe(false);
    expect(await events(t.id)).toEqual([]); // nothing recorded for the owner
  });

  it("unassigned open tasks (the operator's tracker items, R3) never alert", async () => {
    const title = `untracked ${runId}`;
    const t: any = await postTask(poster, { namespace: ns("project"), title } as any);
    await db().from("tasks").update({ updated_at: new Date(Date.now() - 90 * MIN).toISOString() }).eq("id", t.id);
    const r: any = await listTasks(watcher, {});
    expect(alertsOf(r).some((x) => x.includes(title))).toBe(false);
  });

  it("stops once claimed, completed or cancelled (and claiming is still only by the target: R2)", async () => {
    const claimed = await stale();
    await claimTask(target, { id: claimed.id } as any);
    const done = await stale();
    await claimTask(target, { id: done.id } as any);
    await completeTask(target, { id: done.id, completion_key: `k-${runId}` } as any);
    const cancelled = await stale();
    await db().from("tasks").update({ status: "cancelled" }).eq("id", cancelled.id);
    const r: any = await listTasks(watcher, {});
    for (const t of [claimed, done, cancelled]) expect(alertsOf(r).some((x) => x.includes(t.title))).toBe(false);
  });

  it("clears for an already-alerted-but-unseen poller the moment it is claimed (no alert for a claimed task)", async () => {
    const t = await stale();
    await claimTask(target, { id: t.id } as any);
    expect(alertsOf(await listTasks(watcher2, {})).some((x) => x.includes(t.title))).toBe(false);
  });

  it("does NOT claim, change status or reset the waiting clock (updated_at untouched)", async () => {
    const t = await stale({}, 45);
    const before = await taskRow(t.id);
    await listTasks(watcher, {});
    const after = await taskRow(t.id);
    expect(after).toMatchObject({ status: "open", claimed_by_token: null, handoff_to: target.ident });
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("peek (worker, REST only): returns the alert every time and records nothing, so a hook still gets it later", async () => {
    const t = await stale();
    for (let i = 0; i < 2; i++) {
      const p: any = await listTasks(watcher, { stale: "peek" });
      expect(alertsOf(p).some((x) => x.includes(t.title))).toBe(true);
    }
    expect(await events(t.id)).toEqual([]);
    const real: any = await listTasks(watcher, {});
    expect(alertsOf(real).some((x) => x.includes(t.title))).toBe(true);
    expect((await events(t.id)).length).toBe(1);
  });

  it("an unknown 'stale' value is not peek (default consume)", async () => {
    const t = await stale();
    await listTasks(watcher, { stale: "yes" });
    expect((await events(t.id)).length).toBe(1);
  });

  it("X is env-injectable (short window for the live proof)", async () => {
    const t = await stale({}, 2);
    expect(alertsOf(await listTasks(watcher, { stale: "peek" })).some((x) => x.includes(t.title))).toBe(false);
    process.env.STALE_TASK_MIN_MINUTES = "1";
    expect(alertsOf(await listTasks(watcher, { stale: "peek" })).some((x) => x.includes(t.title))).toBe(true);
  });

  it("a task in a namespace the poller cannot read is never named (confidential, ungranted)", async () => {
    const proj = await makeProject();
    const t = await stale({}, 31, proj.ns("sub"));
    const fresh = await ctxFor(watcherRaw); // confidential slug list is resolved per request
    const r: any = await listTasks(fresh, {});
    expect(alertsOf(r).some((x) => x.includes(t.title))).toBe(false);
    expect(await events(t.id)).toEqual([]);
  });

  it("dispatch_paused: no alerts (listTasks returns early)", async () => {
    await stale();
    await setFlags({ dispatchPaused: true });
    const r: any = await listTasks({ ...watcher, flags: { dispatchPaused: true, writesFrozen: false } }, {});
    expect(r).toEqual({ tasks: [], dispatch_paused: true });
  });

  it("at most 5 per poll; the rest follow on the next poll", async () => {
    const ts: Array<{ id: string; title: string }> = [];
    for (let i = 0; i < 7; i++) ts.push(await stale({}, 400 + i));
    const mine = (r: any) => alertsOf(r).filter((x) => ts.some((t) => x.includes(t.title)));
    const a = mine(await listTasks(watcher2, {}));
    const b = mine(await listTasks(watcher2, {}));
    expect(a.length).toBeLessThanOrEqual(5);
    expect(a.length + b.length).toBe(7);
    expect(mine(await listTasks(watcher2, {}))).toEqual([]);
  });

  it("heartbeat replies never carry the alert (hooks discard that reply; a dedupe record there would swallow it)", async () => {
    const t = await stale();
    const hb: any = await heartbeat(watcher, {});
    expect(JSON.stringify(hb)).not.toContain("stale_alerts");
    expect(await events(t.id)).toEqual([]);
  });
});

describe("inbox (SessionStart hook text) carries the stale alert", () => {
  it("inbox() returns stale_alerts, inboxText prints them, a second inbox does not repeat", async () => {
    const t = await stale();
    const d: any = await inbox(watcher, {});
    expect(alertsOf(d).some((x) => x.includes(t.title))).toBe(true);
    const text = inboxText(d);
    expect(text).toContain(`unclaimed task for ${target.ident}: ${t.title}, waiting 31 min`);
    expect(text).toMatch(/R2|R3|do not claim|not claim/i);
    const again: any = await inbox(watcher, {});
    expect(alertsOf(again).some((x) => x.includes(t.title))).toBe(false);
  });
  it("inboxText stays byte-identical without alerts", () => {
    expect(inboxText({ ident: "grok@m", tasks: [] })).toBe("agency-board: no pending tasks for grok@m\n");
  });
  it("inboxText with alerts and no own tasks still prints both lines", () => {
    const text = inboxText({ ident: "grok@m", tasks: [], stale_alerts: ["unclaimed task for codex@x: T, waiting 40 min"] });
    expect(text).toContain("agency-board: no pending tasks for grok@m");
    expect(text).toContain("unclaimed task for codex@x: T, waiting 40 min");
  });
  it("update_task status open (a release) restarts the waiting clock, so a just-released task does not alert yet", async () => {
    const t = await stale({}, 90);
    await claimTask(target, { id: t.id } as any);
    await updateTask(target, { id: t.id, status: "open" } as any);
    const r: any = await listTasks(watcher, { stale: "peek" });
    expect(alertsOf(r).some((x) => x.includes(t.title))).toBe(false);
  });
});
