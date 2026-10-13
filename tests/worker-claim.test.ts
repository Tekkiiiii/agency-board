import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { postTask, claimTask, listTasks } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, asDirector, setRoleFor, withTestDirector, cleanup } from "./helpers";

// Auto-worker claim safety against the real claim RPC (hub_claim): two pollers (or a poller and a
// manual claim) racing on one task -> exactly one winner; identity-targeted tasks are claimable
// only by that identity. Uses the shared helpers read-only (cleanup sweeps this run).

let poster: AgentCtx, codexA: AgentCtx, codexB: AgentCtx;
let posterTok: { deviceId: string };

beforeAll(async () => {
  const pt = await mintToken("claude", { machine: "wk0" });
  posterTok = pt;
  poster = asDirector(await ctxFor(pt.raw));
  codexA = await ctxFor((await mintToken("codex", { machine: "wk1" })).raw);
  codexB = await ctxFor((await mintToken("codex", { machine: "wk2" })).raw);
});
afterAll(async () => { await cleanup(); });

let n = 0;
const post = async (handoff_to?: string) =>
  ((await postTask(poster, { namespace: ns("project"), title: `worker race ${runId} ${++n}`, ...(handoff_to ? { handoff_to } : {}) } as any)) as any).id as string;

describe("auto-worker claim race (atomic hub_claim)", () => {
  it("three concurrent claims on a task handed to 'codex': exactly one winner, the rest 409", async () => {
    const id = await post("codex");
    const rs = await Promise.allSettled([claimTask(codexA, { id } as any), claimTask(codexB, { id } as any), claimTask(codexA, { id } as any)]);
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of rs.filter((r) => r.status === "rejected") as PromiseRejectedResult[]) {
      expect(r.reason).toMatchObject({ status: 409, code: "CONFLICT" });
    }
  });

  it("a task handed to one codex identity is not claimable by another codex machine", async () => {
    const id = await post(codexA.ident);
    await expect(claimTask(codexB, { id } as any)).rejects.toMatchObject({ status: 409 });
    const t: any = await claimTask(codexA, { id } as any);
    expect(t.id).toBe(id);
  });

  it("mine=1 lists identity-targeted and 'codex' tasks, never unassigned ones", async () => {
    const unassigned = await post();
    const mine = await post(codexB.ident);
    const r: any = await listTasks(codexB, { mine: true, status: "open" } as any);
    const ids = r.tasks.map((t: any) => t.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(unassigned);
  });

  it("list_tasks returns assigned_by_role: the assigner's CURRENT role, resolved at read time", async () => {
    let id = "";
    await withTestDirector("claude", posterTok.deviceId, async () => {
      id = await post(codexB.ident);
      const r: any = await listTasks(codexB, { mine: true, status: "open" } as any);
      expect(r.tasks.find((t: any) => t.id === id)).toMatchObject({ assigned_by: poster.ident, assigned_by_role: "director" });
    });
    // withTestDirector demoted the test identity back to lead: same stored task, new answer.
    const lead: any = await listTasks(codexB, { mine: true, status: "open" } as any);
    expect(lead.tasks.find((t: any) => t.id === id).assigned_by_role).toBe("lead");
    await setRoleFor("claude", posterTok.deviceId, "member");
    const member: any = await listTasks(codexB, { mine: true, status: "open" } as any);
    expect(member.tasks.find((t: any) => t.id === id).assigned_by_role).toBe("member");
  });

  it("assigned_by_role is null for an unassigned task and for an assigner on an unknown machine", async () => {
    const unassigned = await post(); // no handoff_to -> assigned_by null
    const { roleOfIdents } = await import("../lib/roles");
    const m = await roleOfIdents(["claude@no-such-machine-" + runId, "not-an-ident", poster.ident]);
    expect(m.get("claude@no-such-machine-" + runId)).toBeNull();
    expect(m.get("not-an-ident")).toBeNull();
    expect(m.get(poster.ident)).not.toBeNull();
    const r: any = await listTasks(poster, { status: "open", namespace: ns("project") } as any);
    expect(r.tasks.find((t: any) => t.id === unassigned)).toMatchObject({ assigned_by: null, assigned_by_role: null });
  });
});
