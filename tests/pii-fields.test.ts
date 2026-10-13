// CONTRACT §13 tier 3: customer PII is blocked in EVERY free-text field an agent, the director (`review`) or
// the admin/dashboard can write. One case per field: a Vietnamese mobile number -> 422 CUSTOMER_PII_BLOCKED
// (details {rule}, no echo) and nothing is stored. Live DB; every row is runId-scoped and removed by cleanup().
// Fields whose format forbids spaces (namespace, slug, target, machine name) get the digits-only form,
// prefixed with test-<runId> so a regression that DID store something is still cleaned up.
// §13.5 class 5: one credential case per field group -> 422 CREDENTIALS_BLOCKED (credentials blocked in ALL namespaces).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../lib/embed", () => ({ EMBED_MODEL: "gte-small", embed: vi.fn(async () => null) }));

import { embed } from "../lib/embed";
import { db } from "../lib/db";
import * as H from "../lib/handlers";
import { reassignTask } from "../lib/dash/board";
import { approveInboxItem, editMemory } from "../lib/dash/memory";
import { issueConnectCode } from "../lib/devices";
import { createProject, renameProject } from "../lib/roles";
import type { AgentCtx } from "../lib/types";
import { apiErr, asDirector, cleanup, ctxFor, makeProject, mintToken, ns, projSlug, runId } from "./helpers";

const embedSpy = vi.mocked(embed);
const PHONE = "0912 345 678";
const DIGITS = "0912345678";
const TEXT = `gọi lại khách theo số ${PHONE} ${runId}`;
const PII_NS = ns("shared", DIGITS); // shared/test-<runId>/0912345678
const PII_TARGET = `claude@test-${runId}-${DIGITS}`;

function expectPii(e: any) {
  expect(e).toMatchObject({ status: 422, code: "CUSTOMER_PII_BLOCKED" });
  expect(e.details?.rule).toBe("phone");
  const blob = JSON.stringify({ message: e?.message, details: e?.details });
  expect(blob).not.toContain(PHONE);
  expect(blob).not.toContain(DIGITS);
}

/** Every column value of every row, as one string: the phone must not appear in it. */
function noPhone(rows: unknown[] | null) {
  const blob = JSON.stringify(rows ?? []);
  expect(blob).not.toContain(PHONE);
  expect(blob).not.toContain(DIGITS);
}

let ctx: AgentCtx; // lead, writes in shared / project
let tokenId: string;
let taskId: string; // clean task, claimed by ctx
let memId: string; // clean memory, for the dashboard edit

/** heartbeat: 2 calls / 60 s per token, enforce() before the guard -> a fresh token per call (same identity). */
async function hbCtx(): Promise<{ c: AgentCtx; tokenId: string }> {
  const t = await mintToken("claude", { machine: "pii" });
  return { c: await ctxFor(t.raw), tokenId: t.tokenId };
}

async function memoriesOfRun() {
  const { data, error } = await db()
    .from("memories")
    .select("namespace,slug,content,tags,target_namespace")
    .or(`namespace.like.%test-${runId}%,target_namespace.like.%test-${runId}%,author_token.eq.${tokenId}`);
  if (error) throw error;
  return data;
}

async function eventsOf(id: string) {
  const { data, error } = await db().from("task_events").select("kind,note").eq("task_id", id);
  if (error) throw error;
  return data;
}

async function taskRow(id: string) {
  const { data, error } = await db().from("tasks").select("*").eq("id", id).single();
  if (error) throw error;
  return data;
}

describe("PII guard on every free-text field (live DB)", () => {
  beforeAll(async () => {
    const t = await mintToken("claude", { machine: "pii" });
    tokenId = t.tokenId;
    ctx = await ctxFor(t.raw);
    expect(ctx.role).toBe("lead");

    const task: any = await H.postTask(ctx, { namespace: ns("project", "pii"), title: `clean task ${runId}` });
    taskId = task.id;
    await H.claimTask(ctx, { id: taskId });

    const { data, error } = await db()
      .from("memories")
      .insert({ namespace: ns("shared", "edit"), slug: "clean", content: `clean memory ${runId}`, author_agent: "claude", author_token: tokenId })
      .select("id")
      .single();
    if (error) throw error;
    memId = data.id;
  });
  beforeEach(() => embedSpy.mockClear());
  afterAll(cleanup);

  // ------------------------------------------------------------ memories (remember)
  describe("memories via remember", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["namespace", { namespace: PII_NS, content: `clean ${runId}` }],
      ["slug", { namespace: ns("shared"), slug: `test-${runId}-${DIGITS}`, content: `clean ${runId}` }],
      ["content", { namespace: ns("shared"), content: TEXT }],
      ["tags", { namespace: ns("shared"), content: `clean ${runId}`, tags: ["ok", PHONE] }],
      ["link slug", { namespace: ns("shared"), content: `clean ${runId}`, links: [{ slug: `test-${runId}-${DIGITS}` }] }],
      ["link namespace", { namespace: ns("shared"), content: `clean ${runId}`, links: [{ slug: "x", namespace: PII_NS }] }],
      ["wiki-link in content", { namespace: ns("shared"), content: `see [[test-${runId}-${DIGITS}]] ${runId}` }],
    ];
    it.each(cases)("remember %s -> 422, nothing stored, no embed", async (_f, input) => {
      expectPii(await apiErr(H.remember(ctx, input)));
      expect(embedSpy).not.toHaveBeenCalled();
      noPhone(await memoriesOfRun());
      const { data: links } = await db().from("memory_links").select("to_slug,to_namespace").like("to_slug", `%${DIGITS}%`);
      expect(links ?? []).toEqual([]);
    });
  });

  // ------------------------------------------------------------ tasks
  describe("tasks", () => {
    const posts: Array<[string, Record<string, unknown>]> = [
      ["namespace", { namespace: ns("project", DIGITS), title: `clean ${runId}` }],
      ["title", { namespace: ns("project"), title: TEXT }],
      ["body", { namespace: ns("project"), title: `clean ${runId}`, body: TEXT }],
      ["handoff_to", { namespace: ns("project"), title: `clean ${runId}`, handoff_to: PII_TARGET }],
    ];
    it.each(posts)("post_task %s -> 422, nothing stored", async (_f, input) => {
      expectPii(await apiErr(H.postTask(ctx, input)));
      const { data } = await db().from("tasks").select("*").like("namespace", `%test-${runId}%`);
      noPhone(data);
    });

    it("update_task result JSON -> 422, result unchanged, no event", async () => {
      const before = await taskRow(taskId);
      expectPii(await apiErr(H.updateTask(ctx, { id: taskId, result: { contact: PHONE } })));
      expect((await taskRow(taskId)).result).toEqual(before.result);
      noPhone(await eventsOf(taskId));
    });

    it("complete_task result JSON -> 422, task still claimed", async () => {
      expectPii(await apiErr(H.completeTask(ctx, { id: taskId, completion_key: `key-${runId}`, result: { contact: PHONE } })));
      const t = await taskRow(taskId);
      expect(t.status).toBe("claimed");
      noPhone([t]);
    });

    it("handoff to -> 422, task unchanged", async () => {
      expectPii(await apiErr(H.handoff(ctx, { id: taskId, to: PII_TARGET, note: `clean ${runId}` })));
      const t = await taskRow(taskId);
      expect(t.status).toBe("claimed");
      noPhone([t]);
    });
  });

  // ------------------------------------------------------------ task_events.note
  describe("task_events.note", () => {
    const notes: Array<[string, () => Promise<unknown>]> = [
      ["update_task note (lease renew)", () => H.updateTask(ctx, { id: taskId, note: TEXT })],
      ["update_task note + status open (released)", () => H.updateTask(ctx, { id: taskId, status: "open", note: TEXT })],
      ["update_task note + status failed", () => H.updateTask(ctx, { id: taskId, status: "failed", note: TEXT })],
      ["handoff note", () => H.handoff(ctx, { id: taskId, to: "codex", note: TEXT })],
      ["dashboard reassign target (event note + handoff_to)", () => reassignTask(taskId, PII_TARGET, [PII_TARGET])],
    ];
    it.each(notes)("%s -> 422, no event stored, task still claimed", async (_f, call) => {
      expectPii(await apiErr(call()));
      noPhone(await eventsOf(taskId));
      const t = await taskRow(taskId);
      expect(t.status).toBe("claimed");
      noPhone([t]);
    });
  });

  // ------------------------------------------------------------ approvals
  describe("approvals", () => {
    let approvalId: string;
    beforeAll(async () => {
      const a: any = await H.requestApproval(ctx, { question: `clean question ${runId}?` });
      approvalId = a.id;
    });

    async function approvalsOfRun() {
      const { data, error } = await db().from("approvals").select("question,options,answer,status").eq("requested_by_token", tokenId);
      if (error) throw error;
      return data ?? [];
    }

    it("request_approval question -> 422, nothing stored", async () => {
      expectPii(await apiErr(H.requestApproval(ctx, { question: TEXT })));
      noPhone(await approvalsOfRun());
    });

    it("request_approval options -> 422, nothing stored", async () => {
      expectPii(await apiErr(H.requestApproval(ctx, { question: `clean ${runId}?`, options: ["yes", PHONE] })));
      noPhone(await approvalsOfRun());
    });

    it("admin approvalDecide answer -> 422, approval still pending", async () => {
      expectPii(await apiErr(H.approvalDecide({ id: approvalId, decision: "approved", answer: TEXT })));
      const rows = await approvalsOfRun();
      noPhone(rows);
      expect(rows.every((r: any) => r.status === "pending" && r.answer === null)).toBe(true);
    });

    it("director review answer -> 422, approval still pending", async () => {
      expectPii(await apiErr(H.review(asDirector(ctx), { kind: "approval", id: approvalId, decision: "approved", answer: TEXT })));
      const rows = await approvalsOfRun();
      noPhone(rows);
      expect(rows.every((r: any) => r.status === "pending")).toBe(true);
    });
  });

  // ------------------------------------------------------------ agent_tokens (heartbeat)
  describe("agent_tokens via heartbeat", () => {
    it.each([["model"], ["status_note"]])("heartbeat %s -> 422, token row unchanged", async (field) => {
      const { c, tokenId: id } = await hbCtx();
      expectPii(await apiErr(H.heartbeat(c, { [field]: field === "model" ? `model ${PHONE}` : TEXT })));
      const { data, error } = await db().from("agent_tokens").select("model,status_note,last_heartbeat_at").eq("id", id).single();
      if (error) throw error;
      expect(data).toEqual({ model: null, status_note: null, last_heartbeat_at: null });
    });
  });

  // ------------------------------------------------------------ inbox approve namespace override
  describe("inbox approve namespace override", () => {
    let inboxId: string;
    beforeAll(async () => {
      const { data, error } = await db()
        .from("memories")
        .insert({
          namespace: "shared/inbox", slug: `test-${runId}-inbox`, content: `clean inbox item ${runId}`, author_agent: "claude",
          author_token: tokenId, target_namespace: ns("shared", "inbox"), review_status: "pending",
        })
        .select("id")
        .single();
      if (error) throw error;
      inboxId = data.id;
    });

    const approves: Array<[string, () => Promise<unknown>]> = [
      ["admin inboxApprove", () => H.inboxApprove({ id: inboxId, namespace: PII_NS })],
      ["director review", () => H.review(asDirector(ctx), { kind: "inbox", id: inboxId, decision: "approve", namespace: PII_NS })],
      ["dashboard approveInboxItem", () => approveInboxItem(inboxId, PII_NS)],
    ];
    it.each(approves)("%s into a PII namespace -> 422, item still pending, no copy", async (_f, call) => {
      expectPii(await apiErr(call()));
      const { data } = await db().from("memories").select("review_status").eq("id", inboxId).single();
      expect(data?.review_status).toBe("pending");
      noPhone(await memoriesOfRun());
    });
  });

  // ------------------------------------------------------------ dashboard memory edit
  it("dashboard editMemory content -> 422, no new version row", async () => {
    expectPii(await apiErr(editMemory({ id: memId, content: TEXT })));
    const { data } = await db().from("memories").select("id,slug,content").eq("namespace", ns("shared", "edit"));
    expect((data ?? []).map((r: any) => r.id)).toEqual([memId]);
    noPhone(data);
    expect(embedSpy).not.toHaveBeenCalled();
  });

  // ------------------------------------------------------------ admin: confidential project names, machine names
  describe("admin", () => {
    it("createProject name -> 422, no project row", async () => {
      const slug = projSlug("pii");
      expectPii(await apiErr(createProject(slug, `Khách ${PHONE}`)));
      const { data } = await db().from("confidential_projects").select("slug").eq("slug", slug);
      expect(data ?? []).toEqual([]);
    });

    it("renameProject name -> 422, name unchanged, no audit row", async () => {
      const p = await makeProject("ren");
      expectPii(await apiErr(renameProject(p.slug, `Khách ${PHONE}`)));
      const { data } = await db().from("confidential_projects").select("name").eq("slug", p.slug).single();
      expect(data?.name).toBe(p.name);
      const { data: audit } = await db().from("admin_audit").select("detail").eq("target", p.slug);
      noPhone(audit);
    });

    it("issueConnectCode machine name -> 422, no connect code stored", async () => {
      const name = `test-${runId}-${DIGITS}`;
      expectPii(await apiErr(issueConnectCode({ machineName: name, agents: ["claude"], os: "mac" }, "http://localhost:13100")));
      const { data } = await db().from("connect_codes").select("machine_name").eq("machine_name", name);
      expect(data ?? []).toEqual([]);
    });
  });

  // ------------------------------------------------------------ class 5 credentials (§13.5, ALL namespaces)
  describe("class 5 credentials -> 422 CREDENTIALS_BLOCKED in every field group", () => {
    const SECRET = "Tq7#mZ2vLp";
    const CRED = `staging login password: ${SECRET}`;
    const CRED_MACHINE = `test-${runId}-192.168.1.20`; // private IP (internal_host); fits the machine-name format

    function expectCred(e: any, ...secrets: string[]) {
      expect(e).toMatchObject({ status: 422, code: "CREDENTIALS_BLOCKED" });
      expect(typeof e.details?.rule).toBe("string");
      const blob = JSON.stringify({ message: e?.message, details: e?.details });
      for (const s of [SECRET, ...secrets]) expect(blob).not.toContain(s);
    }
    const noSecret = (rows: unknown) => expect(JSON.stringify(rows ?? [])).not.toContain(SECRET);

    it("remember content (non-confidential namespace claude/test-<runId>) -> 422, nothing stored, no embed", async () => {
      expectCred(await apiErr(H.remember(ctx, { namespace: ns("claude"), content: CRED })));
      expect(embedSpy).not.toHaveBeenCalled();
      noSecret(await memoriesOfRun());
    });

    it("post_task title -> 422, nothing stored", async () => {
      expectCred(await apiErr(H.postTask(ctx, { namespace: ns("project"), title: CRED })));
      const { data } = await db().from("tasks").select("*").like("namespace", `%test-${runId}%`);
      noSecret(data);
    });

    it("update_task note -> 422, no event stored, task still claimed", async () => {
      expectCred(await apiErr(H.updateTask(ctx, { id: taskId, note: CRED })));
      noSecret(await eventsOf(taskId));
      expect((await taskRow(taskId)).status).toBe("claimed");
    });

    it("request_approval question -> 422, nothing stored", async () => {
      expectCred(await apiErr(H.requestApproval(ctx, { question: CRED })));
      const { data } = await db().from("approvals").select("question,options").eq("requested_by_token", tokenId);
      noSecret(data);
    });

    it("heartbeat status_note (fresh token) -> 422, token row unchanged", async () => {
      const { c, tokenId: id } = await hbCtx();
      expectCred(await apiErr(H.heartbeat(c, { status_note: CRED })));
      const { data, error } = await db().from("agent_tokens").select("model,status_note,last_heartbeat_at").eq("id", id).single();
      if (error) throw error;
      expect(data).toEqual({ model: null, status_note: null, last_heartbeat_at: null });
    });

    it("createProject / renameProject name -> 422, nothing stored", async () => {
      const slug = projSlug("cred");
      expectCred(await apiErr(createProject(slug, `Vault ${CRED}`)));
      const { data } = await db().from("confidential_projects").select("slug").eq("slug", slug);
      expect(data ?? []).toEqual([]);
      const p = await makeProject("cren");
      expectCred(await apiErr(renameProject(p.slug, `Vault ${CRED}`)));
      const { data: row } = await db().from("confidential_projects").select("name").eq("slug", p.slug).single();
      expect(row?.name).toBe(p.name);
    });

    it("issueConnectCode machine name with a private IP -> 422, no connect code stored", async () => {
      expectCred(await apiErr(issueConnectCode({ machineName: CRED_MACHINE, agents: ["claude"], os: "mac" }, "http://localhost:13100")), "192.168.1.20");
      const { data } = await db().from("connect_codes").select("machine_name").eq("machine_name", CRED_MACHINE);
      expect(data ?? []).toEqual([]);
    });
  });

  // ------------------------------------------------------------ controls (the guard does not over-block)
  describe("controls", () => {
    it("clean heartbeat model/status_note are stored", async () => {
      const { c, tokenId: id } = await hbCtx();
      await H.heartbeat(c, { model: "opus", status_note: `working ${runId}` });
      const { data } = await db().from("agent_tokens").select("model,status_note").eq("id", id).single();
      expect(data).toEqual({ model: "opus", status_note: `working ${runId}` });
    });

    it("clean update_task note is stored as an event", async () => {
      await H.updateTask(ctx, { id: taskId, note: `progress ${runId}` });
      expect((await eventsOf(taskId)).some((e: any) => e.note === `progress ${runId}`)).toBe(true);
    });

    it("clean project name and machine name pass", async () => {
      const p = await makeProject("ok");
      expect(await renameProject(p.slug, `Renamed ${runId}`)).toEqual({ slug: p.slug, name: `Renamed ${runId}` });
      const r = await issueConnectCode({ machineName: `test-${runId}-ok`, agents: ["claude"] }, "http://localhost:13100");
      expect(r.code).toBeTruthy();
    });
  });
});
