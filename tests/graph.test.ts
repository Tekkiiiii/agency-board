import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";
import { embed } from "../lib/embed";
import { remember, recall } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { runId, ns, mintToken, ctxFor, cleanup } from "./helpers";

let claude: AgentCtx;
let live = false;
const space = ns("shared", "graph");
const links = async (fromId: string) =>
  (await db().from("memory_links").select("*").eq("from_id", fromId)).data ?? [];
const put = (content: string, extra: Record<string, unknown> = {}): Promise<any> =>
  remember(claude, { namespace: space, content, ...extra } as any);

beforeAll(async () => {
  claude = await ctxFor((await mintToken("claude")).raw);
  live = (await embed(["probe"])) !== null;
  if (!live) console.warn("graph.test: embed() returned null; embedding-dependent cases are skipped (T1 embed not live)");
});
afterAll(cleanup);

describe("graph (real embeddings)", () => {
  it("near-duplicate memory gets an auto relates_to link to the first", async (t) => {
    if (!live) t.skip("embed() not live");
    const a = await put(`The agency-board server for run ${runId} is deployed on Vercel Hobby in the Singapore region.`);
    const b = await put(`The agency-board server for run ${runId} is deployed to Vercel Hobby in the Singapore region.`);
    expect(b.auto_links).toBeGreaterThanOrEqual(1);
    const auto = (await links(b.id)).find((l: any) => l.to_id === a.id && l.auto);
    expect(auto).toMatchObject({ relation: "relates_to", created_by: "auto" });
    expect(auto.score).toBeGreaterThanOrEqual(0.85);
  });

  it("recall uses the vector branch: paraphrase query finds the memory", async (t) => {
    if (!live) t.skip("embed() not live");
    const m = await put(`Hermes posts its daily marketing digest at nine in the morning (${runId}).`);
    const res: any = await recall(claude, { q: "when does hermes send the daily marketing summary", namespace: space } as any);
    expect((res.hits ?? []).map((h: any) => h.id)).toContain(m.id);
  });
});

describe("graph (links, no embeddings needed)", () => {
  it("[[slug]] explicit link resolves to the existing memory", async () => {
    const target = await put(`target note ${runId}`, { slug: `target-${runId}` });
    const src = await put(`see [[target-${runId}]] for details`);
    const l = (await links(src.id)).find((x: any) => x.to_id === target.id);
    expect(l).toBeTruthy();
    expect(l.auto).toBe(false);
  });

  it("dangling link attaches when the target is written later", async () => {
    const slug = `later-${runId}`;
    const src = await put(`depends on [[${slug}]] which does not exist yet`);
    const dangling = (await links(src.id)).find((x: any) => x.to_slug === slug);
    expect(dangling).toBeTruthy();
    expect(dangling.to_id).toBeNull();
    const target = await put(`the later note ${runId}`, { slug });
    const resolved = (await links(src.id)).find((x: any) => x.to_slug === slug || x.to_id === target.id);
    expect(resolved.to_id).toBe(target.id);
  });

  it("supersedes hides the old memory from recall", async () => {
    const word = `zs${runId}`;
    const old = await put(`old fact ${word}`);
    const neu = await put(`new fact ${word}`, { supersedes: old.id });
    const res: any = await recall(claude, { q: word, namespace: space } as any);
    const ids = (res.hits ?? []).map((h: any) => h.id);
    expect(ids).toContain(neu.id);
    expect(ids).not.toContain(old.id);
  });

  it("recall returns neighbours labelled with their relation", async () => {
    const word = `zn${runId}`;
    const a = await put(`anchor ${word}`, { slug: `anchor-${runId}` });
    const b = await put(`follow-up that links [[anchor-${runId}]]`);
    // limit 1: hub_neighbors drops neighbours that are themselves hits, and the vector branch
    // returns every memory in the namespace as a hit, so b must not be a hit to show as a neighbour.
    const res: any = await recall(claude, { q: word, namespace: space, limit: 1 } as any);
    const hit = (res.hits ?? []).find((h: any) => h.id === a.id);
    expect(hit).toBeTruthy();
    const nb = (hit.neighbors ?? []).find((n: any) => n.id === b.id);
    expect(nb).toBeTruthy();
    expect(["relates_to", "supersedes", "part_of", "about_project"]).toContain(nb.relation);
    expect(nb.direction).toBe("in");
  });
});
