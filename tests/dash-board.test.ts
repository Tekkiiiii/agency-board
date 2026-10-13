import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";
import {
  BOARD_COLUMNS,
  activeIdents,
  cancelTask,
  staleSummary,
  staleTasks,
  confidentialLabel,
  groupColumns,
  leaseExpired,
  readableError,
  reassignTask,
  retryTask,
  type BoardTask,
} from "../lib/dash/board";
import { describeLease, formatLease, leaseRemainingMs } from "../app/dashboard/tasks/lease";
import { ApiError } from "../lib/types";
import { TIER_MESSAGES } from "../lib/guard";
import { runId, ns, cleanup } from "./helpers";

// ---------- pure helpers ----------

function task(over: Partial<BoardTask>): BoardTask {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    namespace: "project/x",
    title: "t",
    status: "open",
    created_by: "claude",
    claimed_by_token: null,
    claimed_by_agent: null,
    lease_expires_at: null,
    attempts: 0,
    handoff_to: null,
    assigned_by: null,
    created_at: "2026-10-07T00:00:00Z",
    updated_at: null,
    started_at: null,
    completed_at: null,
    ...over,
  };
}

describe("stale (unclaimed) tasks flag", () => {
  const NOW = Date.parse("2026-10-13T10:00:00Z");
  const MIN = 60_000;
  const old = (min: number) => new Date(NOW - min * MIN).toISOString();
  const X = 30 * MIN;

  it("open + handed to someone + waited > X (updated_at, else created_at); everything else is not stale", () => {
    const a = task({ id: "a", handoff_to: "codex@m", updated_at: old(31) });
    const b = task({ id: "b", handoff_to: "codex@m", updated_at: old(29) });
    const c = task({ id: "c", handoff_to: null, updated_at: old(300) }); // the operator's tracker item (R3)
    const d = task({ id: "d", handoff_to: "codex@m", status: "claimed", updated_at: old(300) });
    const e = task({ id: "e", handoff_to: "codex@m", status: "blocked", updated_at: old(300) });
    const f = task({ id: "f", handoff_to: "claude", updated_at: null, created_at: old(95) });
    const out = staleTasks([a, b, c, d, e, f], NOW, X);
    expect(out.map((t) => [t.id, t.waiting_min])).toEqual([["f", 95], ["a", 31]]); // longest wait first
  });
  it("exactly X is not yet stale (strictly greater)", () => {
    expect(staleTasks([task({ handoff_to: "codex", updated_at: old(30) })], NOW, X)).toEqual([]);
  });

  it("activeIdents: non-revoked identities seen (heartbeat or token use) within the active window", () => {
    const row = (agent: string, machine: string, seenMinAgo: number | null, revoked = false) => ({
      agent, machine, revoked, last_heartbeat_at: null as string | null, last_used_at: seenMinAgo === null ? null : old(seenMinAgo),
    });
    const act = activeIdents(
      [row("claude", "m1", 3), row("codex", "m2", 11), row("claude", "m3", 9.9), row("grok", "m4", null), row("claude", "m5", 1, true)] as any,
      NOW, 10 * MIN,
    );
    expect(act).toEqual(["claude@m1", "claude@m3"]);
  });

  it("staleSummary: counts and who could see it; nobody-active is explicit", () => {
    const stale = staleTasks([task({ handoff_to: "codex@m2", updated_at: old(40) })], NOW, X);
    expect(staleSummary(stale, ["claude@m1", "codex@m2"])).toMatchObject({ count: 1, watchers: ["claude@m1"], nobodyActive: false });
    expect(staleSummary(stale, [])).toMatchObject({ count: 1, watchers: [], nobodyActive: true });
    expect(staleSummary([], [])).toMatchObject({ count: 0, nobodyActive: false });
  });
});

describe("lease countdown formatting", () => {
  it("formats mm:ss under an hour, rounding seconds up", () => {
    expect(formatLease(9 * 60_000 + 42_000)).toBe("09:42");
    expect(formatLease(9 * 60_000 + 41_001)).toBe("09:42");
    expect(formatLease(500)).toBe("00:01");
    expect(formatLease(59_000)).toBe("00:59");
  });
  it("formats h:mm:ss from an hour", () => {
    expect(formatLease(3_600_000)).toBe("1:00:00");
    expect(formatLease(3_723_000)).toBe("1:02:03");
  });
  it("says expired at or past zero and for non-finite input", () => {
    expect(formatLease(0)).toBe("expired");
    expect(formatLease(-1)).toBe("expired");
    expect(formatLease(Number.NaN)).toBe("expired");
  });
  it("remaining ms from lease_expires_at", () => {
    const now = Date.parse("2026-10-07T10:00:00Z");
    expect(leaseRemainingMs("2026-10-07T10:10:00Z", now)).toBe(600_000);
    expect(leaseRemainingMs("2026-10-07T09:59:00Z", now)).toBe(-60_000);
    expect(leaseRemainingMs(null, now)).toBeNull();
    expect(leaseRemainingMs("not a date", now)).toBeNull();
  });
  it("screen-reader text", () => {
    expect(describeLease(61_000)).toBe("1 minute 1 second left on lease");
    expect(describeLease(0)).toBe("lease expired");
  });
});

describe("board helpers", () => {
  it("groups tasks into columns preserving order, cancelled separate", () => {
    const rows = [
      task({ id: "a", status: "open" }),
      task({ id: "b", status: "claimed" }),
      task({ id: "c", status: "open" }),
      task({ id: "d", status: "done" }),
      task({ id: "e", status: "failed" }),
      task({ id: "f", status: "cancelled" }),
      task({ id: "g", status: "blocked", handoff_to: "claude" }),
    ];
    const g = groupColumns(rows);
    expect(g.open.map((t) => t.id)).toEqual(["a", "c"]);
    expect(g.claimed.map((t) => t.id)).toEqual(["b"]);
    expect(g.done.map((t) => t.id)).toEqual(["d"]);
    expect(g.failed.map((t) => t.id)).toEqual(["e"]);
    expect(g.cancelled.map((t) => t.id)).toEqual(["f"]);
    expect(g.blocked.map((t) => t.id)).toEqual(["g"]);
  });
  it("blocked is a board column between claimed and done; a blocked task never counts as an expired lease", () => {
    expect([...BOARD_COLUMNS]).toEqual(["open", "claimed", "blocked", "done", "failed"]);
    const now = Date.parse("2026-10-07T10:00:00Z");
    expect(leaseExpired(task({ status: "blocked", lease_expires_at: "2026-10-07T09:00:00Z" }), now)).toBe(false);
  });
  it("expired lease only for claimed tasks with a past lease", () => {
    const now = Date.parse("2026-10-07T10:00:00Z");
    expect(leaseExpired(task({ status: "claimed", lease_expires_at: "2026-10-07T09:59:59Z" }), now)).toBe(true);
    expect(leaseExpired(task({ status: "claimed", lease_expires_at: "2026-10-07T10:00:01Z" }), now)).toBe(false);
    expect(leaseExpired(task({ status: "open", lease_expires_at: "2026-10-07T09:00:00Z" }), now)).toBe(false);
    expect(leaseExpired(task({ status: "claimed", lease_expires_at: null }), now)).toBe(false);
  });
  it("confidential badge label", () => {
    const conf = ["confidential"];
    expect(confidentialLabel("project/confidential/notes", conf)).toBe("confidential: confidential");
    expect(confidentialLabel("project/acme/notes", conf)).toBeNull(); // project/acme is NOT confidential (§13 tier 1)
    expect(confidentialLabel("project/other", conf)).toBeNull();
    expect(confidentialLabel("confidential/x", conf)).toBeNull();
    expect(confidentialLabel("project/confidential", null)).toBeNull();
  });
  it("readable errors", () => {
    expect(readableError(new ApiError(409, "CONFLICT", "Cannot cancel: the task is done now."))).toEqual({
      status: 409,
      message: "Cannot cancel: the task is done now.",
    });
    // §13: both tier errors are readable 422s with the rule and no content, from ApiError and from the DB trigger.
    for (const e of [
      new ApiError(422, "CUSTOMER_PII_BLOCKED", "Customer personal information must not be stored. Remove it and save only the non-personal facts.", { rule: "cccd" }),
      { code: "P0001", message: "CUSTOMER_PII_BLOCKED:cccd" },
    ]) {
      const r = readableError(e);
      expect(r.status).toBe(422);
      expect(r.message).toMatch(/personal information/i);
    }
    for (const e of [
      new ApiError(422, "CONFIDENTIAL", "confidential contract content must be saved with confidential=true in project/confidential (needs a grant).", { rule: "contract_no" }),
      { code: "P0001", message: "CONFIDENTIAL:contract_no" },
    ]) {
      const r = readableError(e);
      expect(r.status).toBe(422);
      expect(r.message).toMatch(/confidential/);
    }
    expect(readableError(new Error("boom")).status).toBe(500);
  });
  // §13.5 classes 3-5: readable 422s from ApiError and from the DB trigger (`<CODE>:<rule>`, migration 0004).
  it.each([
    ["EMPLOYEE_PII_BLOCKED", "staff_id", /employee personal information/i],
    ["FINANCIALS_BLOCKED", "budget_amount", /non-public financial/i],
    ["CREDENTIALS_BLOCKED", "password", /credentials/i],
  ] as const)("readable errors: %s from ApiError and from the DB trigger", (code, rule, re) => {
    for (const e of [new ApiError(422, code, TIER_MESSAGES[code], { rule }), { code: "P0001", message: `${code}:${rule}` }]) {
      const r = readableError(e);
      expect(r.status).toBe(422);
      expect(r.message).toMatch(re);
      expect(r.message).toContain(`rule: ${rule}`);
    }
  });
});

// ---------- integration: reassign / cancel / retry on a runId-scoped task ----------

let assignedByReady = false;
let skipReason = "";

beforeAll(async () => {
  const { error } = await db().from("tasks").select("assigned_by").limit(1);
  if (error) {
    skipReason = `tasks.assigned_by missing (${error.code ?? "unknown"}): migration 20261007000002 not applied`;
    console.warn(`[dash-board.test] skipping integration test: ${skipReason}`);
  } else assignedByReady = true;
});

afterAll(async () => {
  await cleanup();
});

async function insertClaimed(suffix: string): Promise<string> {
  const { data, error } = await db()
    .from("tasks")
    .insert({
      namespace: ns("project"),
      title: `dash-board ${runId} ${suffix}`,
      status: "claimed",
      created_by: "claude",
      claimed_by_agent: "codex",
      lease_expires_at: new Date(Date.now() + 600_000).toISOString(),
      attempts: 2,
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}
const rowOf = async (id: string) => (await db().from("tasks").select("*").eq("id", id).single()).data as any;
const eventsOf = async (id: string) =>
  ((await db().from("task_events").select("kind, actor, note").eq("task_id", id).order("id")).data ?? []) as any[];

describe("admin task mutations (integration)", () => {
  it("cancel + retry: status-conditional, attempts kept, events by owner", async () => {
    const id = await insertClaimed("cancel");

    await expect(retryTask(id)).rejects.toMatchObject({ status: 409, code: "CONFLICT" }); // claimed is not retryable

    await cancelTask(id);
    expect(await rowOf(id)).toMatchObject({ status: "cancelled", claimed_by_agent: null, lease_expires_at: null, attempts: 2 });
    await expect(cancelTask(id)).rejects.toMatchObject({ status: 409 });

    await retryTask(id);
    expect(await rowOf(id)).toMatchObject({ status: "open", attempts: 2, claimed_by_agent: null, lease_expires_at: null });
    await expect(retryTask(id)).rejects.toMatchObject({ status: 409 });

    const ev = await eventsOf(id);
    expect(ev.map((e) => e.kind)).toEqual(["cancelled", "retried"]);
    expect(ev.every((e) => e.actor === "owner")).toBe(true);

    await expect(cancelTask("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ status: 404 });
    await expect(cancelTask("not-a-uuid")).rejects.toMatchObject({ status: 422 });
  });

  it("reassign: claimed -> open for the target, claim cleared, assigned_by owner, event handoff", async (ctx) => {
    if (!assignedByReady) {
      ctx.skip(skipReason);
      return;
    }
    const id = await insertClaimed("reassign");
    await expect(reassignTask(id, "grok@nowhere", ["claude", "codex"])).rejects.toMatchObject({ status: 422 });
    await reassignTask(id, "claude", ["claude", "codex"]);
    expect(await rowOf(id)).toMatchObject({
      status: "open",
      handoff_to: "claude",
      assigned_by: "owner",
      claimed_by_agent: null,
      lease_expires_at: null,
      attempts: 2,
    });
    const ev = await eventsOf(id);
    expect(ev.map((e) => e.kind)).toEqual(["handoff"]);
    expect(ev[0]).toMatchObject({ actor: "owner" });
    expect(ev[0].note).toContain("to claude");

    await cancelTask(id);
    await reassignTask(id, "codex", ["claude", "codex"]); // cancelled tasks can be reassigned (reopens them)
    expect((await rowOf(id)).status).toBe("open");
  });

  // Needs migration 20261008000006 (status 'blocked'). Not skipped: before the migration it fails with a named cause.
  it("blocked tasks: reassign reopens for the new target; cancel works; claim cleared", async () => {
    const { data, error } = await db()
      .from("tasks")
      .insert({ namespace: ns("project"), title: `dash-board ${runId} blocked`, status: "blocked", created_by: "claude", handoff_to: "claude", assigned_by: "codex@laptop", attempts: 1 })
      .select("id")
      .single();
    if (error) throw new Error(`migration 20261008000006 not applied: tasks.status check rejects 'blocked' (${error.code}: ${error.message})`);
    const id = data.id as string;
    await reassignTask(id, "codex", ["claude", "codex"]);
    expect(await rowOf(id)).toMatchObject({ status: "open", handoff_to: "codex", assigned_by: "owner", claimed_by_agent: null, lease_expires_at: null, attempts: 1 });
    await expect(reassignTask("00000000-0000-4000-8000-000000000000", "codex", ["codex"])).rejects.toMatchObject({ status: 404 });

    const id2 = (await db().from("tasks").update({ status: "blocked" }).eq("id", id).select("id").single()).data!.id as string;
    await cancelTask(id2);
    expect((await rowOf(id2)).status).toBe("cancelled");
    expect((await eventsOf(id2)).map((e) => e.kind)).toEqual(["handoff", "cancelled"]);
  });
});
