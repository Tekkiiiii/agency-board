import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";
import { recall, getMemory, getNeighbors, remember, inboxApprove } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, cleanup, idsOf, apiErr } from "./helpers";

const marker = `zq${runId}`;
let claude: AgentCtx, hermes: AgentCtx;
let claudeTok: string, hermesTok: string;
const ids: Record<string, string> = {};

async function insertMem(key: string, row: Record<string, unknown>) {
  const { data, error } = await db().from("memories").insert(row).select("id").single();
  if (error) throw error;
  ids[key] = data.id;
}

beforeAll(async () => {
  const c = await mintToken("claude");
  const h = await mintToken("hermes");
  claudeTok = c.tokenId; hermesTok = h.tokenId;
  claude = await ctxFor(c.raw);
  hermes = await ctxFor(h.raw);

  await insertMem("S", { namespace: ns("shared"), slug: "s", content: `shared secret note ${marker}`,
    author_agent: "claude", author_token: claudeTok });
  await insertMem("H1", { namespace: ns("hermes"), slug: "h1", content: `hermes one ${marker}`,
    author_agent: "hermes", author_token: hermesTok });
  await insertMem("H2", { namespace: ns("hermes"), slug: "h2", content: `hermes two only reachable through S`,
    author_agent: "hermes", author_token: hermesTok });
  await insertMem("I", { namespace: "shared/inbox", slug: `test-${runId}-i`,
    content: `inbox copy of the shared secret note ${marker}`, author_agent: "hermes", author_token: hermesTok,
    review_status: "approved", target_namespace: ns("hermes") });
  const { error } = await db().from("memory_links").insert([
    { from_id: ids.H1, to_id: ids.S, relation: "relates_to", created_by: "test" },
    { from_id: ids.S, to_id: ids.H2, relation: "relates_to", created_by: "test" },
    { from_id: ids.I, to_id: ids.S, relation: "relates_to", created_by: "test" },
  ]);
  if (error) throw error;
});

afterAll(cleanup);

function allIdsAndNs(res: any): { ids: string[]; namespaces: string[] } {
  const hits: any[] = res.hits ?? [];
  const nodes = [...hits, ...hits.flatMap((h) => h.neighbors ?? [])];
  return { ids: nodes.map((n) => n.id), namespaces: nodes.map((n) => n.namespace) };
}

describe("restricted-agent isolation (default AGENCY_BOARD_RESTRICTED_AGENTS = hermes)", () => {
  it("recall never returns shared/* hits or neighbours to hermes", async () => {
    const res: any = await recall(hermes, { q: `shared secret ${marker}`, limit: 20 } as any);
    const { ids: got, namespaces } = allIdsAndNs(res);
    expect(got).toContain(ids.I); // control: the approved inbox item is readable
    expect(got).not.toContain(ids.S);
    expect(got).not.toContain(ids.H2);
    expect(namespaces.filter((n) => n.startsWith("shared/") && n !== "shared/inbox")).toEqual([]);
  });

  it("getNeighbors(H1, depth 2) does not bridge through S", async () => {
    const res: any = await getNeighbors(hermes, { id: ids.H1, depth: 2 } as any);
    const got = idsOf(res);
    expect(got).not.toContain(ids.S);
    expect(got).not.toContain(ids.H2);
  });

  it("getMemory(S) is 403/404 for hermes", async () => {
    const e = await apiErr(getMemory(hermes, { id: ids.S } as any));
    expect([403, 404]).toContain(e.status);
  });

  it("claude (control) sees S and its neighbours", async () => {
    const res: any = await recall(claude, { q: `shared secret ${marker}`, limit: 20 } as any);
    expect(allIdsAndNs(res).ids).toContain(ids.S);
    const nb = idsOf(await getNeighbors(claude, { id: ids.H1, depth: 2 } as any));
    expect(nb).toContain(ids.S);
    expect(nb).toContain(ids.H2);
  });

  it("hermes remember to shared/* lands in shared/inbox pending; visible to claude only after approve", async () => {
    const target = ns("shared", "x");
    const m2 = `zr${runId}`;
    const r: any = await remember(hermes, { namespace: target, content: `hermes proposal ${m2}` } as any);
    expect(r.namespace).toBe("shared/inbox");
    expect(r.review_status).toBe("pending");
    const { data: row } = await db().from("memories").select("target_namespace, review_status").eq("id", r.id).single();
    expect(row).toMatchObject({ target_namespace: target, review_status: "pending" });

    const before: any = await recall(claude, { q: m2 } as any);
    expect(allIdsAndNs(before).ids).not.toContain(r.id);

    const approved: any = await inboxApprove({ id: r.id }); // copies into target_namespace (new id)
    expect(approved.namespace).toBe(target);
    const after: any = await recall(claude, { q: m2 } as any);
    const hit = (after.hits ?? []).find((h: any) => h.id === approved.id);
    expect(hit).toBeTruthy();
    expect(hit.namespace).toBe(target);
  });
});
