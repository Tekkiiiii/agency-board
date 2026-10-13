import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";
import { setFlags } from "../lib/flags";
import { postTask, listTasks, claimTask, heartbeat, completeTask, handoff, remember, updateTask, ackTask, inbox } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, asDirector, cleanup, apiErr } from "./helpers";

let claudeRaw: string, codexRaw: string;
let claude: AgentCtx, codex: AgentCtx;

beforeAll(async () => {
  claudeRaw = (await mintToken("claude", { machine: "m1" })).raw;
  codexRaw = (await mintToken("codex", { machine: "m2" })).raw;
  claude = await ctxFor(claudeRaw);
  codex = await ctxFor(codexRaw);
});

afterAll(async () => {
  await setFlags({ dispatchPaused: false, writesFrozen: false });
  await cleanup();
});

let n = 0;
async function newTask(extra: Record<string, unknown> = {}): Promise<string> {
  const t: any = await postTask(claude, { namespace: ns("project"), title: `task ${runId} ${++n}`, ...extra } as any);
  expect(t.id).toBeTruthy();
  return t.id;
}
const taskRow = async (id: string) => (await db().from("tasks").select("*").eq("id", id).single()).data;

describe("board", () => {
  it("claim race: exactly one winner, loser 409", async () => {
    const id = await newTask();
    const results = await Promise.allSettled([claimTask(claude, { id } as any), claimTask(codex, { id } as any)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("expired lease can be claimed by another agent", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    await expect(claimTask(codex, { id } as any)).rejects.toMatchObject({ status: 409 });
    await db().from("tasks").update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", id);
    const t: any = await claimTask(codex, { id } as any);
    expect(t.claimed_by_agent ?? (await taskRow(id)).claimed_by_agent).toBe("codex");
  });

  it("heartbeat renews the claimer's lease; non-claimer gets LEASE_LOST", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    const soon = new Date(Date.now() + 60_000).toISOString();
    await db().from("tasks").update({ lease_expires_at: soon }).eq("id", id);
    await heartbeat(claude, { task_id: id } as any);
    expect(new Date((await taskRow(id)).lease_expires_at).getTime()).toBeGreaterThan(new Date(soon).getTime());
    await expect(heartbeat(codex, { task_id: id } as any)).rejects.toMatchObject({ status: 409, code: "LEASE_LOST" });
  });

  it("completeTask: ok, same-key replay, different-key conflict", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    const key = `key-${runId}-a`;
    const first: any = await completeTask(claude, { id, completion_key: key, result: { n: 1 } } as any);
    expect(first.outcome).toBe("ok");
    const again: any = await completeTask(claude, { id, completion_key: key, result: { n: 1 } } as any);
    expect(again.outcome).toBe("replay");
    expect(again.task.id).toBe(first.task.id);
    expect(again.task.status).toBe("done");
    await expect(completeTask(claude, { id, completion_key: `key-${runId}-b` } as any))
      .rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("completeTask by non-claimer -> 409 NOT_CLAIMER", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    await expect(completeTask(codex, { id, completion_key: `key-${runId}-c` } as any))
      .rejects.toMatchObject({ status: 409, code: "NOT_CLAIMER" });
  });

  it("handoff reopens the task and it shows in the target's mine list", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    // claude and codex both default to lead; lead -> lead is allowed since 2026-10-07 (roles.test.ts covers the rule). Director hand kept as-is.
    await handoff(asDirector(claude), { id, to: "codex", note: "over to you" } as any);
    const row = await taskRow(id);
    expect(row.status).toBe("open");
    expect(row.handoff_to).toBe("codex");
    const res: any = await listTasks(codex, { mine: true } as any);
    expect((res.tasks ?? res).map((t: any) => t.id)).toContain(id);
  });

  it("kill switches: dispatchPaused and writesFrozen", async () => {
    const id = await newTask();
    try {
      await setFlags({ dispatchPaused: true });
      const paused = await ctxFor(codexRaw);
      const res: any = await listTasks(paused, {} as any);
      expect(res.dispatch_paused).toBe(true);
      expect(res.tasks).toEqual([]);
      await expect(claimTask(paused, { id } as any)).rejects.toMatchObject({ status: 423, code: "DISPATCH_PAUSED" });

      await setFlags({ dispatchPaused: false, writesFrozen: true });
      const frozen = await ctxFor(claudeRaw);
      await expect(remember(frozen, { namespace: ns("shared"), content: "frozen" } as any))
        .rejects.toMatchObject({ status: 423, code: "WRITES_FROZEN" });
    } finally {
      await setFlags({ dispatchPaused: false, writesFrozen: false });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// C6: complete + notify (atomic) and the `blocked` status. These need migration 20261008000006 on the hosted DB.
// assert0006() runs first and fails with a message naming the missing piece (not a raw PostgREST error).
// ---------------------------------------------------------------------------------------------------------------
async function assert0006(): Promise<void> {
  const col = await db().from("tasks").select("notify_pending").limit(1);
  if (col.error) throw new Error(`MIGRATION 0006 NOT APPLIED: tasks.notify_pending column missing (${col.error.code}: ${col.error.message})`);
  const probe = await db().from("tasks").insert({ namespace: ns("project", "probe"), title: `probe ${runId}`, status: "blocked", created_by: "probe" }).select("id").single();
  if (probe.error) throw new Error(`MIGRATION 0006 NOT APPLIED: tasks.status 'blocked' rejected by the CHECK constraint (${probe.error.code}: ${probe.error.message})`);
  const fn = await db().rpc("hub_complete", { p_task: "00000000-0000-0000-0000-000000000000", p_token: "00000000-0000-0000-0000-000000000000", p_key: "probe-key-0", p_result: null, p_status: "done", p_notify: null, p_ident: null, p_note: null });
  if (fn.error) throw new Error(`MIGRATION 0006 NOT APPLIED: hub_complete(p_notify, p_ident, p_note) signature missing (${fn.error.code}: ${fn.error.message})`);
}
const statusOf = async (p: Promise<unknown>) => {
  const e = await apiErr(p);
  const { errorResponse } = await import("../lib/request");
  const res = errorResponse(e);
  return { status: res.status, code: ((await res.json()) as any).error.code };
};
const inboxIds = async (ctx: AgentCtx) => ((await inbox(ctx, {})) as any).tasks.map((t: any) => t.id) as string[];
const eventsOf = async (id: string, kind: string) => (await db().from("task_events").select("kind, note, actor").eq("task_id", id).eq("kind", kind)).data ?? [];

describe("complete + notify (needs migration 0006)", () => {
  beforeAll(assert0006);

  it("notify: one atomic call closes the task and puts it in the target's inbox; ack clears it (idempotent, one event)", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    const key = `key-${runId}-n1`;
    const first: any = await completeTask(claude, { id, completion_key: key, status: "done", result: { n: 1 }, note: "all good", notify: codex.ident } as any);
    expect(first.outcome).toBe("ok");
    expect(first.task).toMatchObject({ status: "done", handoff_to: codex.ident, assigned_by: claude.ident, notify_pending: true });
    expect((await eventsOf(id, "done"))[0].note).toBe(`notify ${codex.ident}: all good`);

    expect(await inboxIds(codex)).toContain(id);
    expect(await inboxIds(claude)).not.toContain(id); // claude is the completer, not the target
    const listed: any = await inbox(codex, {});
    expect(listed.tasks.find((t: any) => t.id === id)).toMatchObject({ status: "done", notify_pending: true });

    // only the addressee may ack: anyone else sees a nonexistent task
    expect(await statusOf(ackTask(claude, { id } as any))).toEqual({ status: 404, code: "NOT_FOUND" });
    const acked: any = await ackTask(codex, { id } as any);
    expect(acked).toMatchObject({ id, status: "done", notify_pending: false });
    expect(await inboxIds(codex)).not.toContain(id);
    expect(await eventsOf(id, "update")).toHaveLength(1);
    expect((await eventsOf(id, "update"))[0].note).toBe("acked");

    const again: any = await ackTask(codex, { id } as any); // idempotent: 200, same row, no new event
    expect(again).toMatchObject({ id, notify_pending: false });
    expect(await eventsOf(id, "update")).toHaveLength(1);
  });

  it("replay with the same key returns the stored row incl. notify fields and never re-flips notify_pending after an ack", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    const key = `key-${runId}-n2`;
    await completeTask(claude, { id, completion_key: key, result: { n: 2 }, notify: codex.agent } as any); // bare agent target
    const replay1: any = await completeTask(claude, { id, completion_key: key, result: { n: 2 }, notify: codex.agent } as any);
    expect(replay1.outcome).toBe("replay");
    expect(replay1.task).toMatchObject({ status: "done", handoff_to: "codex", assigned_by: claude.ident, notify_pending: true });
    await ackTask(codex, { id } as any); // bare-agent target: the codex agent acks
    const replay2: any = await completeTask(claude, { id, completion_key: key, result: { n: 2 }, notify: codex.agent } as any);
    expect(replay2.outcome).toBe("replay");
    expect(replay2.task).toMatchObject({ handoff_to: "codex", notify_pending: false });
    expect((await taskRow(id)).notify_pending).toBe(false);
    await expect(completeTask(claude, { id, completion_key: `key-${runId}-n2b`, notify: codex.ident } as any)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("complete without notify leaves handoff_to / notify_pending untouched; failed + notify works", async () => {
    const plain = await newTask({ handoff_to: claude.ident });
    await claimTask(claude, { id: plain } as any);
    await completeTask(claude, { id: plain, completion_key: `key-${runId}-n3`, result: {} } as any);
    expect(await taskRow(plain)).toMatchObject({ status: "done", handoff_to: claude.ident, notify_pending: false });

    const bad = await newTask();
    await claimTask(claude, { id: bad } as any);
    const r: any = await completeTask(claude, { id: bad, completion_key: `key-${runId}-n4`, status: "failed", result: { code: "X" }, notify: codex.ident } as any);
    expect(r.task).toMatchObject({ status: "failed", handoff_to: codex.ident, notify_pending: true });
    expect(await inboxIds(codex)).toContain(bad);
    expect((await listTasks(codex, { status: "failed" } as any) as any).tasks.map((t: any) => t.id)).toContain(bad);
  });

  it("non-claimer with notify -> 409 NOT_CLAIMER and nothing is written", async () => {
    const id = await newTask();
    await claimTask(claude, { id } as any);
    await expect(completeTask(codex, { id, completion_key: `key-${runId}-n5`, notify: claude.ident } as any)).rejects.toMatchObject({ status: 409, code: "NOT_CLAIMER" });
    expect(await taskRow(id)).toMatchObject({ status: "claimed", notify_pending: false });
  });

  it("claiming a notified done task is not possible; ack on an open task is a no-op 200", async () => {
    const id = await newTask({ handoff_to: codex.ident });
    expect(await taskRow(id)).toMatchObject({ status: "open", notify_pending: false });
    const row: any = await ackTask(codex, { id } as any);
    expect(row).toMatchObject({ id, status: "open", notify_pending: false });
    expect(await eventsOf(id, "update")).toHaveLength(0);
  });
});

describe("blocked status (needs migration 0006)", () => {
  beforeAll(assert0006);

  async function handedTo(who: AgentCtx): Promise<string> {
    return newTask({ handoff_to: who.ident }); // claude posts, so assigned_by = claude.ident
  }

  it("claimer blocks: defaults to assigned_by, releases the claim, event kind blocked, shows in the target's inbox", async () => {
    const id = await handedTo(codex);
    await claimTask(codex, { id } as any);
    const t: any = await updateTask(codex, { id, status: "blocked", note: "folder not mapped" } as any);
    expect(t).toMatchObject({ status: "blocked", handoff_to: claude.ident, assigned_by: codex.ident, claimed_by_token: null, lease_expires_at: null, notify_pending: false });
    const ev = await eventsOf(id, "blocked");
    expect(ev).toHaveLength(1);
    expect(ev[0].note).toBe(`to ${claude.ident}: folder not mapped`);

    expect(await inboxIds(claude)).toContain(id);
    expect((await inbox(claude, {}) as any).tasks.find((x: any) => x.id === id).status).toBe("blocked");
    expect(await inboxIds(codex)).not.toContain(id);
    // list_tasks: default includes blocked, explicit filter works, the claimer's token no longer holds it
    expect(((await listTasks(claude, {} as any)) as any).tasks.map((x: any) => x.id)).toContain(id);
    expect(((await listTasks(claude, { status: "blocked" } as any)) as any).tasks.map((x: any) => x.id)).toContain(id);
    expect(((await listTasks(claude, { status: "open" } as any)) as any).tasks.map((x: any) => x.id)).not.toContain(id);
  });

  it("note is required (422 VALIDATION); only the claimer may block (409 NOT_CLAIMER)", async () => {
    const id = await handedTo(codex);
    await claimTask(codex, { id } as any);
    expect(await statusOf(updateTask(codex, { id, status: "blocked" } as any))).toEqual({ status: 422, code: "VALIDATION" });
    expect(await statusOf(updateTask(codex, { id, status: "blocked", note: "   " } as any))).toEqual({ status: 422, code: "VALIDATION" });
    expect(await statusOf(updateTask(claude, { id, status: "blocked", note: "not mine" } as any))).toEqual({ status: 409, code: "NOT_CLAIMER" });
    expect((await taskRow(id)).status).toBe("claimed");
  });

  it("explicit `to` overrides assigned_by; target can claim, a non-target cannot; re-claimed blocked task completes", async () => {
    const id = await handedTo(codex);
    await claimTask(codex, { id } as any);
    // exact identity: bare "claude" spans the prod director (lead -> director is ROLE_DENIED, roles.test covers it)
    const t: any = await updateTask(codex, { id, status: "blocked", note: "need claude", to: claude.ident } as any);
    expect(t).toMatchObject({ status: "blocked", handoff_to: claude.ident });
    await expect(claimTask(codex, { id } as any)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    const c: any = await claimTask(claude, { id } as any);
    expect(c).toMatchObject({ status: "claimed", claimed_by_agent: "claude", notify_pending: false });
    const done: any = await completeTask(claude, { id, completion_key: `key-${runId}-b1`, result: { fixed: true } } as any);
    expect(done).toMatchObject({ outcome: "ok" });
    expect(done.task.status).toBe("done");
  });

  it("no routing target (no `to`, no assigned_by) -> handoff_to null, nobody can claim it", async () => {
    const id = await newTask(); // no handoff_to -> assigned_by null
    await claimTask(claude, { id } as any);
    const t: any = await updateTask(claude, { id, status: "blocked", note: "no one to ask" } as any);
    expect(t).toMatchObject({ status: "blocked", handoff_to: null });
    await expect(claimTask(codex, { id } as any)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    await expect(claimTask(claude, { id } as any)).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
    expect(await inboxIds(claude)).not.toContain(id);
  });

  it("existing PATCH shapes still work: status open releases, status failed ends, plain annotate renews", async () => {
    const a = await newTask();
    await claimTask(claude, { id: a } as any);
    expect(await updateTask(claude, { id: a, status: "open", note: "back" } as any)).toMatchObject({ status: "open", claimed_by_token: null });
    const b = await newTask();
    await claimTask(claude, { id: b } as any);
    expect(await updateTask(claude, { id: b, status: "failed", note: "no" } as any)).toMatchObject({ status: "failed" });
    const c = await newTask();
    await claimTask(claude, { id: c } as any);
    expect(await updateTask(claude, { id: c, note: "progress" } as any)).toMatchObject({ status: "claimed" });
  });
});
