// MVP-b0 §12: confidential projects + grants. Uses a throwaway confidential project `t<runId>`
// (namespace project/t<runId>/...). Grants are read per request, so every check builds a fresh ctx.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../lib/embed", () => ({ EMBED_MODEL: "gte-small", embed: vi.fn(async () => null) }));

import { db } from "../lib/db";
import { remember, recall, getMemory, getNeighbors, postTask, listTasks, claimTask, updateTask } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, asDirector, grantFor, makeProject, cleanup, apiErr, idsOf, recallIds } from "./helpers";

const marker = `zg${runId}`;
let proj: Awaited<ReturnType<typeof makeProject>>;
let lead: Awaited<ReturnType<typeof mintToken>>;
let grok: Awaited<ReturnType<typeof mintToken>>;
const ids: Record<string, string> = {};
const fresh = (): Promise<AgentCtx> => ctxFor(lead.raw);

async function insert(table: "memories" | "tasks", key: string, row: Record<string, unknown>) {
  const { data, error } = await db().from(table).insert(row).select("id").single();
  if (error) throw error;
  ids[key] = data.id;
}

async function visibility(ctx: AgentCtx) {
  const inRecall = recallIds(await recall(ctx, { q: marker, limit: 20 })).includes(ids.M);
  const inNeighbors = idsOf(await getNeighbors(ctx, { id: ids.P, depth: 2 })).includes(ids.M);
  const tasks: any = await listTasks(ctx, {});
  const inTasks = (tasks.tasks ?? []).some((t: any) => t.id === ids.T);
  let getOk = true;
  try { await getMemory(ctx, { id: ids.M }); } catch (e: any) { expect(e).toMatchObject({ status: 404, code: "NOT_FOUND" }); getOk = false; }
  return { inRecall, inNeighbors, inTasks, getOk };
}
const INVISIBLE = { inRecall: false, inNeighbors: false, inTasks: false, getOk: false };
const VISIBLE = { inRecall: true, inNeighbors: true, inTasks: true, getOk: true };

beforeAll(async () => {
  proj = await makeProject();
  lead = await mintToken("claude", { machine: "gl" });
  grok = await mintToken("grok", { machine: "gg" });
  const tok = lead.tokenId;
  await insert("memories", "M", { namespace: proj.ns("notes"), slug: "m", content: `confidential plan ${marker}`, author_agent: "codex", author_token: tok });
  await insert("memories", "P", { namespace: ns("shared", "g"), slug: "p", content: `public pointer ${marker}`, author_agent: "codex", author_token: tok });
  await insert("memories", "O", { namespace: ns("project", "open"), slug: "o", content: `open project note ${marker}`, author_agent: "codex", author_token: tok });
  await insert("tasks", "T", { namespace: proj.ns(), title: `confidential task ${runId}`, created_by: "test", created_by_token: tok });
  const { error } = await db().from("memory_links").insert({ from_id: ids.P, to_id: ids.M, relation: "relates_to", created_by: "test" });
  if (error) throw error;
});
afterAll(cleanup);

describe("confidential project grants", () => {
  it("ctx carries the confidential slug list and no grants by default", async () => {
    const ctx = await fresh();
    expect(ctx.role).toBe("lead");
    expect(ctx.confidential).toContain(proj.slug);
    expect(ctx.confidential).toContain("confidential"); // §12 seed
    expect(ctx.confidential).not.toContain("acme"); // project/acme is NOT confidential (§13 tier 1)
    expect(ctx.grants).not.toContain(proj.slug);
  });

  it("no grant -> invisible (recall, get_memory 404, neighbours, list_tasks); claim 404; writes 403 GRANT_REQUIRED", async () => {
    const ctx = await fresh();
    expect(await visibility(ctx)).toEqual(INVISIBLE);
    expect(await apiErr(claimTask(ctx, { id: ids.T }))).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await apiErr(remember(ctx, { namespace: proj.ns("notes"), content: `write attempt ${runId}` })))
      .toMatchObject({ status: 403, code: "GRANT_REQUIRED", details: { project: proj.slug } });
    expect(await apiErr(postTask(ctx, { namespace: proj.ns(), title: `task attempt ${runId}` })))
      .toMatchObject({ status: 403, code: "GRANT_REQUIRED", details: { project: proj.slug } });
  });

  it("tick -> visible on the very next call; a ctx built before the tick stays blind", async () => {
    const stale = await fresh();
    expect(await grantFor("claude", lead.deviceId, proj.slug, true)).toBe(true);
    expect(await grantFor("claude", lead.deviceId, proj.slug, true)).toBe(false); // idempotent, no change

    const ctx = await fresh();
    expect(ctx.grants).toContain(proj.slug);
    expect(await visibility(ctx)).toEqual(VISIBLE);
    expect(await apiErr(getMemory(stale, { id: ids.M }))).toMatchObject({ status: 404 });

    const w: any = await remember(ctx, { namespace: proj.ns("notes"), content: `granted write ${runId}` });
    expect(w.namespace).toBe(proj.ns("notes"));
    const claimed: any = await claimTask(ctx, { id: ids.T });
    expect(claimed.id).toBe(ids.T);
    await updateTask(ctx, { id: ids.T, status: "open", note: "release" });
  });

  it("untick -> invisible again on the next call; claim 404", async () => {
    expect(await grantFor("claude", lead.deviceId, proj.slug, false)).toBe(true);
    const ctx = await fresh();
    expect(ctx.grants).not.toContain(proj.slug);
    expect(await visibility(ctx)).toEqual(INVISIBLE);
    expect(await apiErr(claimTask(ctx, { id: ids.T }))).toMatchObject({ status: 404 });
  });

  it("director without a grant also cannot see it", async () => {
    const dir = asDirector(await fresh());
    expect(dir.grants).not.toContain(proj.slug);
    expect(await visibility(dir)).toEqual(INVISIBLE);
    expect(await apiErr(remember(dir, { namespace: proj.ns("notes"), content: `director write ${runId}` })))
      .toMatchObject({ status: 403, code: "GRANT_REQUIRED" });
  });

  it("a member with the grant still needs the role to permit the namespace", async () => {
    expect(await grantFor("grok", grok.deviceId, proj.slug, true)).toBe(true);
    const ctx = await ctxFor(grok.raw);
    expect(ctx.role).toBe("member");
    expect(ctx.grants).toContain(proj.slug);
    expect(await apiErr(getMemory(ctx, { id: ids.M }))).toMatchObject({ status: 404 });
  });

  it("grant and revoke each wrote one admin_audit row", async () => {
    const { data, error } = await db().from("admin_audit").select("action, target, detail").eq("target", lead.ident).order("id");
    expect(error).toBeNull();
    const rows = (data ?? []).filter((r: any) => r.detail?.project === proj.slug);
    // Contract leaves open whether a no-op re-grant audits; require exactly one revoke and >= 1 grant, grant first.
    const actions = rows.map((r: any) => r.action);
    expect(actions[0]).toBe("grant");
    expect(actions.filter((a: string) => a === "revoke")).toHaveLength(1);
    expect(actions.every((a: string) => a === "grant" || a === "revoke")).toBe(true);
  });

  it("a memory in a non-confidential project stays visible to leads", async () => {
    const ctx = await fresh();
    const m: any = await getMemory(ctx, { id: ids.O });
    expect(m.id).toBe(ids.O);
    expect(recallIds(await recall(ctx, { q: marker, limit: 20 }))).toContain(ids.O);
  });
});
