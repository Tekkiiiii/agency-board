// MVP-b0 §11 / §15: roles per agent@machine, resolved per request.
// Director behaviour is tested with an in-memory ctx (asDirector) except the one-director DB rule,
// which promotes a test identity via withTestDirector() and always restores the real director.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/embed", () => ({ EMBED_MODEL: "gte-small", embed: vi.fn(async () => null) }));

import { db } from "../lib/db";
import {
  remember, recall, getMemory, forget, postTask, listTasks, claimTask, handoff, requestApproval,
  listReviews, review, inbox, inboxText, approvalDecide, completeTask, updateTask, ackTask,
} from "../lib/handlers";
import { scopesForRole, defaultRole, nsMatch } from "../lib/scopes";
import type { AgentCtx, AgentId, Role } from "../lib/types";
import { runId, ns, mintToken, ctxFor, asDirector, setRoleFor, withTestDirector, cleanup, apiErr, recallIds } from "./helpers";

type Tok = Awaited<ReturnType<typeof mintToken>>;
const inboxTextFor = async (ctx: AgentCtx) => inboxText(await inbox(ctx, {}));
const sorted = (a: string[]) => [...a].sort();
const marker = `zr${runId}`;
let L: Tok, L2: Tok, X: Tok, Hm: Tok, Gw: Tok, G: Tok;


// ------------------------------------------------------------------ pure
describe("scopesForRole (pure, §11)", () => {
  it.each(["director", "lead"] as Role[])("%s: read/write everything", (role) => {
    for (const agent of ["claude", "codex", "grok"] as AgentId[]) {
      const s = scopesForRole(agent, role, []);
      expect(s).toEqual({ readNs: ["*"], writeNs: ["*"], inboxOnly: false });
      // assigned patterns never narrow a full-read role
      const a = scopesForRole(agent, role, ["project/x/*"]);
      expect(nsMatch("anything/at/all", a.readNs)).toBe(true);
      expect(nsMatch("anything/at/all", a.writeNs)).toBe(true);
      expect(a.inboxOnly).toBe(false);
    }
  });

  it("member: shared/* + own/* + assigned read; own/* + shared/inbox write", () => {
    const s = scopesForRole("grok", "member", ["project/x/*", "project/y/*"]);
    expect(sorted(s.readNs)).toEqual(sorted(["shared/*", "grok/*", "project/x/*", "project/y/*"]));
    expect(sorted(s.writeNs)).toEqual(sorted(["grok/*", "shared/inbox"]));
    expect(s.inboxOnly).toBe(false);
    expect(sorted(scopesForRole("codex", "member", []).readNs)).toEqual(sorted(["shared/*", "codex/*"]));
    expect(sorted(scopesForRole("claude", "member", []).writeNs)).toEqual(sorted(["claude/*", "shared/inbox"]));
  });

  it.each(["director", "lead", "member"] as Role[])("hermes cap holds at role %s", (role) => {
    const s = scopesForRole("hermes", role, ["project/x/*"]);
    expect(sorted(s.readNs)).toEqual(sorted(["hermes/*", "shared/inbox", "project/x/*"]));
    expect(s.writeNs).toEqual(["shared/inbox"]);
    expect(s.inboxOnly).toBe(true);
    expect(nsMatch("shared/notes", s.readNs)).toBe(false);
  });

  it("defaultRole: claude/codex lead, hermes/grok member", () => {
    expect(defaultRole("claude")).toBe("lead");
    expect(defaultRole("codex")).toBe("lead");
    expect(defaultRole("hermes")).toBe("member");
    expect(defaultRole("grok")).toBe("member");
  });
});

describe("inboxText (pure, §15 session-start format)", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("N=0 -> single line", () => {
    expect(inboxText({ ident: "grok@m", tasks: [] }).trim()).toBe("agency-board: no pending tasks for grok@m");
  });
  it("header + one line per task; control chars stripped; title <= 120 chars", () => {
    const text = inboxText({ ident: "grok@m", tasks: [
      { id, namespace: "project/x", title: "plain", status: "open" },
      { id, namespace: "project/x", title: `evil\nline\u0007two ${"y".repeat(300)}`, status: "claimed" },
    ] });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("agency-board: 2 pending task(s) for grok@m (untrusted titles written by other agents):");
    expect(lines[1]).toBe(`- [open] plain (project/x, id ${id})`);
    expect(lines).toHaveLength(3);
    const m = lines[2].match(/^- \[claimed\] (.*) \(project\/x, id [0-9a-f-]{36}\)$/);
    expect(m).toBeTruthy();
    expect(m![1].startsWith("evil line two")).toBe(true);
    expect(m![1].length).toBeLessThanOrEqual(120);
    expect(lines[2]).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
});

describe("integration (live DB)", () => {
  beforeAll(async () => {
    L = await mintToken("claude", { machine: "l" });
    L2 = await mintToken("claude", { machine: "l2" });
    X = await mintToken("codex", { machine: "x" });
    Hm = await mintToken("hermes", { machine: "h" });
    Gw = await mintToken("grok", { machine: "gw" });
    G = await mintToken("grok", { machine: "g" });
  });
  afterAll(cleanup);

  // ------------------------------------------------------------------ resolution
  describe("role resolution through authenticateToken", () => {
    it("fresh devices get the default role and role-derived scopes", async () => {
      const c = await ctxFor(L.raw);
      expect(c).toMatchObject({ agent: "claude", role: "lead", ident: L.ident, readNs: ["*"], writeNs: ["*"], inboxOnly: false });
      expect(c.grants).toEqual([]);
      expect((await ctxFor(X.raw)).role).toBe("lead");
      const h = await ctxFor(Hm.raw);
      expect(h).toMatchObject({ role: "member", inboxOnly: true, writeNs: ["shared/inbox"] });
      const g = await ctxFor(Gw.raw);
      expect(g.role).toBe("member");
      expect(sorted(g.readNs)).toEqual(sorted(["shared/*", "grok/*"]));
    });

    it("role change via hub_set_role takes effect on the next ctx; hermes stays capped as lead", async () => {
      await setRoleFor("hermes", Hm.deviceId, "lead");
      const h = await ctxFor(Hm.raw);
      expect(h.role).toBe("lead");
      expect(h).toMatchObject({ inboxOnly: true, writeNs: ["shared/inbox"] });
      expect(nsMatch("shared/notes", h.readNs)).toBe(false);
      await setRoleFor("hermes", Hm.deviceId, "member");
      expect((await ctxFor(Hm.raw)).role).toBe("member");
    });
  });

  // ------------------------------------------------------------------ member writes + dispatch
  describe("member writes and dispatch", () => {
    it("member writes own ns ok; shared/x -> 403 SCOPE_DENIED", async () => {
      const g = await ctxFor(Gw.raw);
      const r: any = await remember(g, { namespace: ns("grok"), content: `grok own note ${runId}` });
      expect(r.namespace).toBe(ns("grok"));
      expect(await apiErr(remember(g, { namespace: ns("shared", "x"), content: `nope ${runId}` })))
        .toMatchObject({ status: 403, code: "SCOPE_DENIED" });
    });

    it("member post_task with handoff_to -> 403 ROLE_DENIED; without handoff_to in own ns ok", async () => {
      const g = await ctxFor(Gw.raw);
      expect(await apiErr(postTask(g, { namespace: ns("grok"), title: `dispatch ${runId}`, handoff_to: "claude" })))
        .toMatchObject({ status: 403, code: "ROLE_DENIED" });
      const t: any = await postTask(g, { namespace: ns("grok"), title: `own todo ${runId}` });
      expect(t.id).toBeTruthy();
    });

    it("lead dispatches to a member identity and to a lead; director to anyone", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: ns("project", "d"), title: `for grok ${runId}`, handoff_to: G.ident });
      const { data: row } = await db().from("tasks").select("handoff_to, assigned_by").eq("id", t.id).single();
      expect(row).toEqual({ handoff_to: G.ident, assigned_by: L.ident });

      const ll: any = await postTask(l, { namespace: ns("project", "d"), title: `for codex ${runId}`, handoff_to: X.ident });
      expect(ll.handoff_to).toBe(X.ident);

      const d: any = await postTask(asDirector(l), { namespace: ns("project", "d"), title: `director to codex ${runId}`, handoff_to: X.ident });
      expect(d.handoff_to).toBe(X.ident);
    });

    it("lead handoff tool obeys the same rule (member and lead targets ok, director denied)", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: ns("project", "d"), title: `lead handoff ${runId}` });
      await claimTask(l, { id: t.id });
      const hl: any = await handoff(l, { id: t.id, to: X.ident, note: "to a lead" });
      expect(hl.handoff_to).toBe(X.ident);
      const t2: any = await postTask(l, { namespace: ns("project", "d"), title: `lead handoff member ${runId}` });
      await claimTask(l, { id: t2.id });
      const h: any = await handoff(l, { id: t2.id, to: G.ident, note: "to a member" });
      expect(h.handoff_to).toBe(G.ident);
    });

    it("member hands off sideways (to another member) -> 403; back to assigned_by ok", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: `project/test-${runId}-hb`, title: `round trip ${runId}`, handoff_to: G.ident });
      const g = await ctxFor(G.raw); // fresh: the task makes project/test-<runId>-hb/* assigned
      expect(nsMatch(`project/test-${runId}-hb`, g.readNs)).toBe(true);
      await claimTask(g, { id: t.id });
      expect(await apiErr(handoff(g, { id: t.id, to: Gw.ident, note: "sideways" }))).toMatchObject({ status: 403, code: "ROLE_DENIED" });
      const back: any = await handoff(g, { id: t.id, to: L.ident, note: "done my part" });
      expect(back.handoff_to).toBe(L.ident);
      const { data: row } = await db().from("tasks").select("status, assigned_by").eq("id", t.id).single();
      expect(row).toEqual({ status: "open", assigned_by: G.ident });
    });

  });

  // ------------------------------------------------------------------ upward handoff (§13.4)
  describe("handing work upward is always allowed (§13.4)", () => {
    it("member -> a lead that is NOT assigned_by: allowed (upward)", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: `project/test-${runId}-up`, title: `up to codex ${runId}`, handoff_to: G.ident });
      const g = await ctxFor(G.raw);
      await claimTask(g, { id: t.id });
      const h: any = await handoff(g, { id: t.id, to: X.ident, note: "needs a lead" });
      expect(h.handoff_to).toBe(X.ident);
      const { data: row } = await db().from("tasks").select("status, assigned_by").eq("id", t.id).single();
      expect(row).toEqual({ status: "open", assigned_by: G.ident });
    });

    it("lead -> lead handoff is allowed (lead-to-lead dispatch, 2026-10-07)", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: ns("project", "up"), title: `lead to lead ${runId}` });
      await claimTask(l, { id: t.id });
      const h: any = await handoff(l, { id: t.id, to: L2.ident, note: "same rank" });
      expect(h.handoff_to).toBe(L2.ident);
    });

    it("lead -> director handoff is allowed (real director via withTestDirector)", async () => {
      const D = await mintToken("claude", { machine: "updir" });
      await withTestDirector("claude", D.deviceId, async () => {
        const l = await ctxFor(L.raw);
        expect(l.role).toBe("lead");
        const t: any = await postTask(l, { namespace: ns("project", "up"), title: `escalate ${runId}` });
        await claimTask(l, { id: t.id });
        const h: any = await handoff(l, { id: t.id, to: D.ident, note: "escalating to the director" });
        expect(h.handoff_to).toBe(D.ident);
        const { data: row } = await db().from("tasks").select("handoff_to, assigned_by").eq("id", t.id).single();
        expect(row).toEqual({ handoff_to: D.ident, assigned_by: L.ident });
      });
    });

    it("lead post_task handoff_to a lead -> ok", async () => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: ns("project", "up"), title: `dispatch ${runId}`, handoff_to: L2.ident });
      expect(t.handoff_to).toBe(L2.ident);
    });

    it("lead post_task handoff_to a director -> 403 ROLE_DENIED; mixed lead+director agent -> 403", async () => {
      const D = await mintToken("claude", { machine: "dirpost" });
      await withTestDirector("claude", D.deviceId, async () => {
        const l = await ctxFor(L.raw);
        expect(await apiErr(postTask(l, { namespace: ns("project", "up"), title: `to director ${runId}`, handoff_to: D.ident })))
          .toMatchObject({ status: 403, code: "ROLE_DENIED" });
        // bare "claude" matches lead devices AND the director device -> not every identity is member|lead
        expect(await apiErr(postTask(l, { namespace: ns("project", "up"), title: `to mixed ${runId}`, handoff_to: "claude" })))
          .toMatchObject({ status: 403, code: "ROLE_DENIED" });
      });
    });
  });

  describe("member reads (assigned)", () => {
    it("member reads an assigned project ns only while a task there is handed to it", async () => {
      const g2 = await mintToken("grok", { machine: "ra" });
      const pns = `project/test-${runId}-ra`;
      const l = await ctxFor(L.raw);
      const m: any = await remember(l, { namespace: pns, content: `assigned project note ${runId}` });

      expect(await apiErr(getMemory(await ctxFor(g2.raw), { id: m.id }))).toMatchObject({ status: 404 });
      const t: any = await postTask(l, { namespace: `${pns}/sub`, title: `read this ${runId}`, handoff_to: g2.ident });
      const g = await ctxFor(g2.raw);
      expect(g.readNs).toContain(`${pns}/*`);
      expect(((await getMemory(g, { id: m.id })) as any).id).toBe(m.id);

      await db().from("tasks").update({ status: "cancelled" }).eq("id", t.id);
      expect(await apiErr(getMemory(await ctxFor(g2.raw), { id: m.id }))).toMatchObject({ status: 404 });
    });
  });

  // ------------------------------------------------------------------ forget
  describe("forget (§11)", () => {
    it("lead forgets own only (agent AND machine); director forgets anything it can read", async () => {
      const l = await ctxFor(L.raw);
      const mine: any = await remember(l, { namespace: ns("shared", "f"), content: `mine ${runId}` });
      const sibling: any = await remember(await ctxFor(L2.raw), { namespace: ns("shared", "f"), content: `same agent other machine ${runId}` });
      const other: any = await remember(await ctxFor(X.raw), { namespace: ns("shared", "f"), content: `codex wrote this ${runId}` });

      for (const id of [sibling.id, other.id]) {
        const e = await apiErr(forget(l, { id }));
        expect(e.status).toBe(403);
        expect(["ROLE_DENIED", "SCOPE_DENIED"]).toContain(e.code);
      }
      expect(await forget(l, { id: mine.id })).toMatchObject({ id: mine.id, deleted: true });
      expect(await forget(asDirector(l), { id: other.id })).toMatchObject({ id: other.id, deleted: true });
    });
  });

  // ------------------------------------------------------------------ reviews
  describe("list_reviews / review (director only)", () => {
    it("lead and member -> 403 ROLE_DENIED", async () => {
      for (const raw of [L.raw, Gw.raw]) {
        const ctx = await ctxFor(raw);
        expect(await apiErr(listReviews(ctx, {}))).toMatchObject({ status: 403, code: "ROLE_DENIED" });
        expect(await apiErr(review(ctx, { kind: "approval", id: crypto.randomUUID(), decision: "approved" })))
          .toMatchObject({ status: 403, code: "ROLE_DENIED" });
      }
    });

    it("director ctx lists and decides inbox items and approvals", async () => {
      const target = ns("shared", "r");
      const inboxRow: any = await remember(await ctxFor(Hm.raw), { namespace: target, content: `hermes proposal ${marker}` });
      expect(inboxRow).toMatchObject({ namespace: "shared/inbox", review_status: "pending" });
      const appr: any = await requestApproval(await ctxFor(Gw.raw), { question: `ok to proceed ${runId}?` });

      const dir = asDirector(await ctxFor(L.raw));
      const lists: any = await listReviews(dir, {});
      expect((lists.inbox ?? []).map((r: any) => r.id)).toContain(inboxRow.id);
      expect((lists.approvals ?? []).map((r: any) => r.id)).toContain(appr.id);

      const copy: any = await review(dir, { kind: "inbox", id: inboxRow.id, decision: "approve" });
      expect(copy.namespace).toBe(target);
      const { data: rows } = await db().from("memories").select("id, review_status, approved_by").in("id", [inboxRow.id, copy.id]);
      const byId = new Map((rows ?? []).map((r: any) => [r.id, r]));
      expect(byId.get(inboxRow.id)).toMatchObject({ review_status: "approved", approved_by: L.ident });
      expect(byId.get(copy.id)).toMatchObject({ approved_by: L.ident });

      const decided: any = await review(dir, { kind: "approval", id: appr.id, decision: "approved", answer: "go" });
      expect(decided).toMatchObject({ id: appr.id, status: "approved", answer: "go" });
      const { data: dRow } = await db().from("approvals").select("status, decided_by").eq("id", appr.id).single();
      expect(dRow).toEqual({ status: "approved", decided_by: L.ident });
    });

    it("approvals.decided_by: admin approvalDecide -> 'owner'", async () => {
      const appr: any = await requestApproval(await ctxFor(Gw.raw), { question: `admin decides ${runId}?` });
      const r: any = await approvalDecide({ id: appr.id, decision: "denied", answer: "no" });
      expect(r).toMatchObject({ id: appr.id, status: "denied", answer: "no", decided_by: "owner" });
      const { data: row } = await db().from("approvals").select("decided_by").eq("id", appr.id).single();
      expect(row?.decided_by).toBe("owner");
    });
  });

  // ------------------------------------------------------------------ one director (live DB, restores)
  describe("one director at a time (DB)", () => {
    it("promoting a test identity demotes the current director; second director row is rejected; original restored", async () => {
      const D = await mintToken("claude", { machine: "dir" });
      let originalSeen: { agent: string; device_id: string } | null = null;
      await withTestDirector("claude", D.deviceId, async ({ promoted, original }) => {
        originalSeen = original;
        expect(promoted).toMatchObject({ agent: "claude", device_id: D.deviceId, role: "director" });
        if (original) expect(promoted.demoted).toBeTruthy();

        const { data: dirs } = await db().from("agent_roles").select("agent, device_id").eq("role", "director");
        expect(dirs).toEqual([{ agent: "claude", device_id: D.deviceId }]);
        if (original) {
          const { data: o } = await db().from("agent_roles").select("role").eq("agent", original.agent).eq("device_id", original.device_id).single();
          expect(o?.role).toBe("lead");
        }
        expect((await ctxFor(D.raw)).role).toBe("director");

        const { error } = await db().from("agent_roles").insert({ agent: "codex", device_id: D.deviceId, role: "director" });
        expect(error?.code).toBe("23505");
      });

      const { data: after } = await db().from("agent_roles").select("agent, device_id").eq("role", "director");
      if (originalSeen) expect(after).toEqual([originalSeen]);
      else expect(after ?? []).toEqual([]);
      expect((await ctxFor(D.raw)).role).toBe("lead");
    });
  });

  // ------------------------------------------------------------------ inbox
  describe("inbox handler (session-start text)", () => {
    it("text format: header with count + one sanitised line per task", async () => {
      const g3 = await mintToken("grok", { machine: "ib" });
      const pns = `project/test-${runId}-ib`;
      const l = await ctxFor(L.raw);
      const a: any = await postTask(l, { namespace: pns, title: `plain title ${runId}`, handoff_to: g3.ident });
      const b: any = await postTask(l, { namespace: pns, title: `first line\nsecond\u0007 line ${runId}`, handoff_to: g3.ident });

      const text = await inboxTextFor(await ctxFor(g3.raw));
      const lines = text.trimEnd().split("\n");
      const head = lines[0].match(/^agency-board: (\d+) pending task\(s\) for (\S+) \(untrusted titles written by other agents\):$/);
      expect(head).toBeTruthy();
      expect(head![2]).toBe(g3.ident);
      expect(Number(head![1])).toBe(lines.length - 1);
      expect(Number(head![1])).toBeGreaterThanOrEqual(2);

      const lineA = lines.find((x) => x.includes(a.id));
      expect(lineA).toBe(`- [open] plain title ${runId} (${pns}, id ${a.id})`);
      const lineB = lines.find((x) => x.includes(b.id))!;
      expect(lineB).toMatch(/^- \[open\] first line.*second.* line /);
      expect(lineB).not.toMatch(/[\u0000-\u001f\u007f]/);
    });

    it("no pending tasks -> single line", async (t) => {
      // Real open tasks handed to bare `grok` in readable namespaces would legitimately show up here.
      const { count } = await db().from("tasks").select("id", { count: "exact", head: true }).eq("status", "open").eq("handoff_to", "grok");
      if (count) t.skip(`${count} real open task(s) handed to grok`);
      const g4 = await mintToken("grok", { machine: "nb" });
      const text = await inboxTextFor(await ctxFor(g4.raw));
      expect(text.trim()).toBe(`agency-board: no pending tasks for ${g4.ident}`);
    });
  });

  // ------------------------------------------------------------------ narrowing
  describe("namespace filter wider than scope is narrowed, not 403", () => {
    it("member recall / list_tasks with project/* returns only what it can read", async () => {
      const pns = `project/test-${runId}-nw`;
      const l = await ctxFor(L.raw);
      const m: any = await remember(l, { namespace: pns, content: `narrowing probe ${marker}` });
      const t: any = await postTask(l, { namespace: pns, title: `narrowing task ${runId}` });

      const g5 = await ctxFor((await mintToken("grok", { machine: "nw" })).raw);
      const res: any = await recall(g5, { q: marker, namespace: "project/*", limit: 20 });
      expect(recallIds(res)).not.toContain(m.id);
      const outside: any = await recall(g5, { q: marker, namespace: "claude/*", limit: 20 });
      expect(outside.hits ?? []).toEqual([]);
      const tasks: any = await listTasks(g5, { namespace: "project/*" });
      expect((tasks.tasks ?? []).map((x: any) => x.id)).not.toContain(t.id);

      // control: the lead sees both through the same filter
      expect(recallIds(await recall(l, { q: marker, namespace: "project/*", limit: 20 }))).toContain(m.id);
      expect(((await listTasks(l, { namespace: "project/*" })) as any).tasks.map((x: any) => x.id)).toContain(t.id);
    });
  });
  // ------------------------------------------------------------------ C6: complete+notify and blocked, per role (needs migration 0006)
  describe("complete+notify and blocked obey the dispatch rules (needs migration 0006)", () => {
    beforeAll(async () => {
      const col = await db().from("tasks").select("notify_pending").limit(1);
      if (col.error) throw new Error(`MIGRATION 0006 NOT APPLIED: tasks.notify_pending column missing (${col.error.code}: ${col.error.message})`);
      const probe = await db().from("tasks").insert({ namespace: ns("project", "probe"), title: `probe ${runId}`, status: "blocked", created_by: "probe" }).select("id").single();
      if (probe.error) throw new Error(`MIGRATION 0006 NOT APPLIED: tasks.status 'blocked' rejected by the CHECK constraint (${probe.error.code}: ${probe.error.message})`);
      const fn = await db().rpc("hub_complete", { p_task: "00000000-0000-0000-0000-000000000000", p_token: "00000000-0000-0000-0000-000000000000", p_key: "probe-key-0", p_result: null, p_status: "done", p_notify: null, p_ident: null, p_note: null });
      if (fn.error) throw new Error(`MIGRATION 0006 NOT APPLIED: hub_complete(p_notify, p_ident, p_note) signature missing (${fn.error.code}: ${fn.error.message})`);
    });

    const inboxIdsOf = async (c: AgentCtx) => ((await inbox(c, {})) as any).tasks.map((t: any) => t.id) as string[];
    const rowOf = async (id: string) => (await db().from("tasks").select("*").eq("id", id).single()).data as any;
    const claimedMember = async (suffix: string) => {
      const l = await ctxFor(L.raw);
      const t: any = await postTask(l, { namespace: `project/test-${runId}-${suffix}`, title: `c6 ${suffix} ${runId}`, handoff_to: G.ident });
      const g = await ctxFor(G.raw); // fresh ctx: the task makes the namespace assigned
      await claimTask(g, { id: t.id });
      return { l, g, id: t.id as string };
    };

    it("member -> notify its assigned_by (back) is allowed", async () => {
      const { g, id } = await claimedMember("nb");
      const r: any = await completeTask(g, { id, completion_key: `key-${runId}-rb`, result: { ok: 1 }, notify: L.ident });
      expect(r.task).toMatchObject({ status: "done", handoff_to: L.ident, assigned_by: G.ident, notify_pending: true });
    });

    it("member -> notify a lead that is NOT assigned_by is allowed (upward); member -> director allowed (upward, real director)", async () => {
      const { g, id } = await claimedMember("nu");
      const r: any = await completeTask(g, { id, completion_key: `key-${runId}-ru`, notify: X.ident });
      expect(r.task).toMatchObject({ handoff_to: X.ident, notify_pending: true });

      const D = await mintToken("claude", { machine: "ntdir" });
      await withTestDirector("claude", D.deviceId, async () => {
        const c = await claimedMember("nd");
        const r2: any = await completeTask(c.g, { id: c.id, completion_key: `key-${runId}-rd`, notify: D.ident });
        expect(r2.task).toMatchObject({ handoff_to: D.ident, notify_pending: true });
        const d = await ctxFor(D.raw);
        expect(d.role).toBe("director");
        expect(await inboxIdsOf(d)).toContain(c.id);
        expect(((await ackTask(d, { id: c.id })) as any).notify_pending).toBe(false);
      });
    });

    it("member -> notify sideways (another member) -> 403 ROLE_DENIED and the task stays claimed, nothing half-applied", async () => {
      const { g, id } = await claimedMember("ns");
      expect(await apiErr(completeTask(g, { id, completion_key: `key-${runId}-rs`, notify: Gw.ident }))).toMatchObject({ status: 403, code: "ROLE_DENIED" });
      expect(await rowOf(id)).toMatchObject({ status: "claimed", handoff_to: G.ident, notify_pending: false, completion_key: null });
      // the claim is intact: completing without notify still works afterwards
      const ok: any = await completeTask(g, { id, completion_key: `key-${runId}-rs2` });
      expect(ok.task).toMatchObject({ status: "done", notify_pending: false });
    });

    it("lead -> notify a mixed lead+director agent is rejected (not upward, dispatch rule); lead -> lead and lead -> member are allowed", async () => {
      const D = await mintToken("claude", { machine: "ntmix" });
      await withTestDirector("claude", D.deviceId, async () => {
        const l = await ctxFor(L.raw);
        const t: any = await postTask(l, { namespace: ns("project", "ntmix"), title: `c6 mixed ${runId}` });
        await claimTask(l, { id: t.id });
        expect(await apiErr(completeTask(l, { id: t.id, completion_key: `key-${runId}-rm`, notify: "claude" }))).toMatchObject({ status: 403, code: "ROLE_DENIED" });
        expect((await rowOf(t.id)).status).toBe("claimed");
        const r: any = await completeTask(l, { id: t.id, completion_key: `key-${runId}-rm2`, notify: L2.ident });
        expect(r.task).toMatchObject({ handoff_to: L2.ident, notify_pending: true });
      });
      const l = await ctxFor(L.raw);
      const t2: any = await postTask(l, { namespace: ns("project", "ntmem"), title: `c6 to member ${runId}` });
      await claimTask(l, { id: t2.id });
      expect(((await completeTask(l, { id: t2.id, completion_key: `key-${runId}-rm3`, notify: G.ident })) as any).task.handoff_to).toBe(G.ident);
    });

    it("a notified member can read the namespace, sees the done task in its inbox, acks it; ack revokes the extra read scope", async () => {
      const l = await ctxFor(L.raw);
      const pns = `project/test-${runId}-rd`;
      const t: any = await postTask(l, { namespace: pns, title: `c6 read ${runId}` });
      await claimTask(l, { id: t.id });
      const g0 = await ctxFor(G.raw);
      expect(nsMatch(pns, g0.readNs)).toBe(false);
      await completeTask(l, { id: t.id, completion_key: `key-${runId}-rr`, notify: G.ident, note: "done for you" });
      const g = await ctxFor(G.raw);
      expect(nsMatch(pns, g.readNs)).toBe(true);
      expect(await inboxIdsOf(g)).toContain(t.id);
      expect(await apiErr(ackTask(await ctxFor(Gw.raw), { id: t.id }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
      expect(((await ackTask(g, { id: t.id })) as any).notify_pending).toBe(false);
      expect(await inboxIdsOf(await ctxFor(G.raw))).not.toContain(t.id);
      expect(nsMatch(pns, (await ctxFor(G.raw)).readNs)).toBe(false);
    });

    it("blocked: a member routes back to assigned_by by default; sideways `to` -> 403; upward `to` ok", async () => {
      const a = await claimedMember("bb");
      const b: any = await updateTask(a.g, { id: a.id, status: "blocked", note: "cannot map this folder" });
      expect(b).toMatchObject({ status: "blocked", handoff_to: L.ident, assigned_by: G.ident, claimed_by_token: null });
      expect(await inboxIdsOf(a.l)).toContain(a.id);

      const s = await claimedMember("bs");
      expect(await apiErr(updateTask(s.g, { id: s.id, status: "blocked", note: "x", to: Gw.ident }))).toMatchObject({ status: 403, code: "ROLE_DENIED" });
      expect((await rowOf(s.id)).status).toBe("claimed");
      const up: any = await updateTask(s.g, { id: s.id, status: "blocked", note: "needs a lead", to: X.ident });
      expect(up).toMatchObject({ status: "blocked", handoff_to: X.ident });
    });

    it("blocked routed to a member: the member can read the namespace, sees it in its inbox and claims it; another member cannot", async () => {
      const l = await ctxFor(L.raw);
      const pns = `project/test-${runId}-br`;
      const t: any = await postTask(l, { namespace: pns, title: `c6 blocked ${runId}` });
      await claimTask(l, { id: t.id });
      const r: any = await updateTask(l, { id: t.id, status: "blocked", note: "member please look", to: G.ident });
      expect(r).toMatchObject({ status: "blocked", handoff_to: G.ident });
      const g = await ctxFor(G.raw);
      expect(nsMatch(pns, g.readNs)).toBe(true);
      expect(await inboxIdsOf(g)).toContain(t.id);
      // unreadable task == nonexistent (loadTask): a member with no scope on pns gets 404, not 409
      expect(await apiErr(claimTask(await ctxFor(Gw.raw), { id: t.id }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
      const c: any = await claimTask(g, { id: t.id });
      expect(c).toMatchObject({ status: "claimed", claimed_by_agent: "grok" });
      const done: any = await completeTask(g, { id: t.id, completion_key: `key-${runId}-rbd`, result: { ok: true } });
      expect(done.task.status).toBe("done");
    });
  });
});
