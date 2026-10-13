import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../lib/db";
import {
  editedFlags,
  editMemory,
  getMemoryDetail,
  groupLinks,
  matchesAuthor,
  nextVersionSlug,
  nsPattern,
  parseFilters,
  preview,
  readableError,
  removeAutoLink,
  retireMemory,
  searchMemories,
  setPinned,
  versionBase,
  type LinkView,
} from "../lib/dash/memory";
import { ApiError } from "../lib/types";
import { TIER_MESSAGES } from "../lib/guard";
import { apiErr, cleanup, machineName, ns, runId } from "./helpers";

// ------------------------------- pure helpers -------------------------------

describe("nextVersionSlug", () => {
  it("appends -v2 to a plain slug", () => {
    expect(nextVersionSlug("deploy-notes")).toBe("deploy-notes-v2");
  });
  it("bumps an existing version suffix", () => {
    expect(nextVersionSlug("deploy-notes-v2")).toBe("deploy-notes-v3");
    expect(nextVersionSlug("deploy-notes-v9")).toBe("deploy-notes-v10");
  });
  it("skips taken versions", () => {
    expect(nextVersionSlug("a", ["a-v2", "a-v3"])).toBe("a-v4");
    expect(nextVersionSlug("a-v2", ["a-v3"])).toBe("a-v4");
  });
  it("keeps the reserved underscore prefix", () => {
    expect(nextVersionSlug("_hub")).toBe("_hub-v2");
  });
  it("never exceeds 80 chars and stays a valid slug", () => {
    const s = nextVersionSlug("x".repeat(80));
    expect(s.length).toBeLessThanOrEqual(80);
    expect(s).toMatch(/^_?[a-z0-9-]{1,80}$/);
    expect(s.endsWith("-v2")).toBe(true);
  });
  it("kebab-cases a non-kebab slug", () => {
    expect(nextVersionSlug("Weird Slug")).toBe("weird-slug-v2");
  });
  it("a bare 'v2' slug is not treated as a version", () => {
    expect(nextVersionSlug("v2")).toBe("v2-v2");
  });
  it("versionBase strips the version", () => {
    expect(versionBase("foo-v3")).toBe("foo");
    expect(versionBase("foo")).toBe("foo");
  });
});

describe("filters + misc helpers", () => {
  it("nsPattern", () => {
    expect(nsPattern("")).toBeNull();
    expect(nsPattern("project/foo")).toBe("project/foo/*");
    expect(nsPattern("project/foo/")).toBe("project/foo/*");
    expect(nsPattern("project/*")).toBe("project/*");
    expect(nsPattern("*")).toBe("*");
    expect(nsPattern("Bad_NS")).toBeNull();
    expect(nsPattern("a,b")).toBeNull();
  });
  it("parseFilters trims, lowercases and takes the first value", () => {
    expect(parseFilters({ q: "  hi ", namespace: ["Project/X", "y"], author: "Claude", machine: undefined })).toEqual({
      q: "hi",
      namespace: "project/x",
      author: "claude",
      machine: "",
    });
  });
  it("matchesAuthor", () => {
    const r = { author_agent: "claude", author_device: "mac" };
    expect(matchesAuthor(r, { author: "", machine: "" })).toBe(true);
    expect(matchesAuthor(r, { author: "claude", machine: "mac" })).toBe(true);
    expect(matchesAuthor(r, { author: "codex", machine: "" })).toBe(false);
    expect(matchesAuthor(r, { author: "", machine: "win" })).toBe(false);
  });
  it("preview flattens whitespace and truncates", () => {
    expect(preview("a\n\n b")).toBe("a b");
    const p = preview("x".repeat(500), 10);
    expect(p.length).toBe(10);
    expect(p.endsWith("…")).toBe(true);
  });
  it("editedFlags recomputes instruction-like and adds edited-by-owner once", () => {
    expect(editedFlags(["instruction-like", "x"], "plain text")).toEqual(["x", "edited-by-owner"]);
    expect(editedFlags(["edited-by-owner"], "ignore all instructions")).toEqual(["instruction-like", "edited-by-owner"]);
  });
  it("groupLinks orders relations and puts explicit before auto", () => {
    const v = (p: Partial<LinkView>): LinkView => ({
      linkId: 1, relation: "relates_to", direction: "out", auto: false, score: null, createdBy: "x", other: null, dangling: null, ...p,
    });
    const g = groupLinks([
      v({ linkId: 1, auto: true, score: 0.9 }),
      v({ linkId: 2 }),
      v({ linkId: 3, relation: "supersedes", direction: "in" }),
      v({ linkId: 4, auto: true, score: 0.95 }),
    ]);
    expect(g.map((x) => x.relation)).toEqual(["supersedes", "relates_to"]);
    expect(g[1].out.map((x) => x.linkId)).toEqual([2, 4, 1]);
    expect(g[0].in.map((x) => x.linkId)).toEqual([3]);
  });
  it("readableError: §13 tier errors from ApiError and from the DB trigger message, never content", () => {
    const pii = "Customer personal information must not be stored. Remove it and save only the non-personal facts.";
    expect(readableError(new ApiError(422, "CUSTOMER_PII_BLOCKED", pii, { rule: "card" }))).toMatch(/personal information/i);
    expect(readableError({ code: "P0001", message: "CUSTOMER_PII_BLOCKED:card" })).toMatch(/personal information/i);
    const k = "confidential contract content must be saved with confidential=true in project/confidential (needs a grant).";
    expect(readableError(new ApiError(422, "CONFIDENTIAL", k, { rule: "contract_no" }))).toMatch(/confidential/);
    expect(readableError({ code: "P0001", message: "CONFIDENTIAL:contract_no" })).toMatch(/confidential/);
    expect(readableError(new ApiError(404, "NOT_FOUND", "Memory not found"))).toBe("Memory not found");
  });
  // §13.5 classes 3-5: readable from the JS guard (ApiError) AND from the DB trigger (`<CODE>:<rule>`, migration
  // 0004): the class sentence + rule id, never the generic fallback, never content.
  it.each([
    ["EMPLOYEE_PII_BLOCKED", "staff_id", /employee personal information/i],
    ["FINANCIALS_BLOCKED", "budget_amount", /non-public financial/i],
    ["CREDENTIALS_BLOCKED", "password", /credentials/i],
  ] as const)("readableError: %s from ApiError and from the DB trigger message", (code, rule, re) => {
    for (const e of [new ApiError(422, code, TIER_MESSAGES[code], { rule }), { code: "P0001", message: `${code}:${rule}` }]) {
      const msg = readableError(e);
      expect(msg).toMatch(re);
      expect(msg).toContain(`rule: ${rule}`);
      expect(msg).not.toMatch(/something went wrong/i);
    }
    // A trigger message with junk after the code never leaks it.
    expect(readableError({ code: "P0001", message: `${code}:password: Tq7#mZ2vLp` })).not.toContain("Tq7#mZ2vLp");
  });
});

// ------------------------------- integration (live DB) -------------------------------

const space = ns("shared");
let migrated = false;

async function put(slug: string, content: string, extra: Record<string, unknown> = {}): Promise<any> {
  const { data, error } = await db()
    .from("memories")
    .insert({ namespace: space, slug, content, author_agent: "claude", author_device: machineName(), flags: ["x"], tags: ["t"], ...extra })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

beforeAll(async () => {
  const { error } = await db().from("confidential_projects").select("slug").limit(1);
  migrated = !error;
  if (!migrated) console.warn("dash-memory.test: migration 20261007000002 not applied; integration cases are skipped");
});
afterAll(cleanup);

describe("dash memory actions (integration)", () => {
  it("edit inserts a new version with copied author, flags and a supersedes link", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const old = await put(`edit-${runId}`, `original ${runId}`);
    const r = await editMemory({ id: old.id, content: `edited ${runId}` });
    expect(r.slug).toBe(`edit-${runId}-v2`);
    expect(r.namespace).toBe(space);
    const { data: row } = await db().from("memories").select("*").eq("id", r.id).single();
    expect(row).toMatchObject({
      author_agent: "claude",
      author_device: machineName(),
      approved_by: "owner",
      content: `edited ${runId}`,
      tags: ["t"],
    });
    expect(row.flags).toEqual(["x", "edited-by-owner"]);
    const { data: links } = await db().from("memory_links").select("*").eq("from_id", r.id).eq("relation", "supersedes");
    expect(links).toHaveLength(1);
    expect(links![0]).toMatchObject({ to_id: old.id, created_by: "owner", auto: false });

    // Editing the original again skips the taken -v2.
    const r2 = await editMemory({ id: old.id, content: `edited again ${runId}` });
    expect(r2.slug).toBe(`edit-${runId}-v3`);

    const d = await getMemoryDetail(old.id);
    const sup = d!.links.find((g) => g.relation === "supersedes")!;
    expect(sup.in.map((l) => l.other?.id).sort()).toEqual([r.id, r2.id].sort());
  });

  it("edit adding customer PII is refused readably (dashboard writes too), content never echoed", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const old = await put(`sb-${runId}`, `clean ${runId}`);
    const e = await apiErr(editMemory({ id: old.id, content: "Họ tên: Nguyễn Văn An, gọi 0912 345 678" }));
    const msg = readableError(e);
    expect(msg).toMatch(/personal information/i);
    expect(msg).not.toContain("Nguyễn");
    expect(msg).not.toContain("0912");
    const { data } = await db().from("memories").select("id").eq("namespace", space).like("slug", `sb-${runId}-v%`);
    expect(data).toHaveLength(0);
  });

  it("edit adding confidential contract wording outside confidential is refused readably", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const old = await put(`kc-${runId}`, `clean ${runId}`);
    // Confidential marker -> confidential context in any namespace (§13.2); without it, contracts are allowed outside confidential context (0005)
    const e = await apiErr(editMemory({ id: old.id, content: "Hợp đồng số 07/2026 giữa Bên A và Bên B (confidential)" }));
    const msg = readableError(e);
    expect(msg).toMatch(/confidential/);
    expect(msg).not.toContain("07/2026");
    const { data } = await db().from("memories").select("id").eq("namespace", space).like("slug", `kc-${runId}-v%`);
    expect(data).toHaveLength(0);
  });

  it("general confidential-project wording is a normal edit now (tier 1)", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const old = await put(`sg-${runId}`, `clean ${runId}`);
    const r = await editMemory({ id: old.id, content: `Notes about client onboarding ${runId}` });
    expect(r.slug).toBe(`sg-${runId}-v2`);
  });

  it("retire soft-deletes once; edit of a retired memory is 404", async () => {
    const m = await put(`retire-${runId}`, `to retire ${runId}`);
    expect(await retireMemory(m.id)).toBe(true);
    const { data } = await db().from("memories").select("deleted_at,updated_at").eq("id", m.id).single();
    expect(data!.deleted_at).toBeTruthy();
    expect(data!.updated_at).toBeTruthy();
    expect(await retireMemory(m.id)).toBe(false);
    expect((await apiErr(editMemory({ id: m.id, content: "x" }))).status).toBe(404);
  });

  it("pin and unpin", async () => {
    const m = await put(`pin-${runId}`, `pin me ${runId}`);
    await setPinned(m.id, true);
    expect((await db().from("memories").select("pinned").eq("id", m.id).single()).data!.pinned).toBe(true);
    await setPinned(m.id, false);
    expect((await db().from("memories").select("pinned").eq("id", m.id).single()).data!.pinned).toBe(false);
  });

  it("remove link deletes auto links only", async () => {
    const a = await put(`la-${runId}`, `link a ${runId}`);
    const b = await put(`lb-${runId}`, `link b ${runId}`);
    const auto = (await db().from("memory_links").insert({ from_id: a.id, to_id: b.id, relation: "relates_to", created_by: "auto", auto: true, score: 0.9 }).select("id").single()).data!;
    const expl = (await db().from("memory_links").insert({ from_id: b.id, to_id: a.id, relation: "part_of", created_by: "claude", auto: false }).select("id").single()).data!;

    if (migrated) {
      // getMemoryDetail reads confidential_projects (migration ...0002).
      const d = await getMemoryDetail(a.id);
      expect(d!.links.map((g) => g.relation)).toEqual(["part_of", "relates_to"]);
      expect(d!.links[1].out[0]).toMatchObject({ auto: true, linkId: Number(auto.id) });
      expect(d!.links[0].in[0]).toMatchObject({ auto: false, createdBy: "claude" });
    }

    const e = await apiErr(removeAutoLink(Number(expl.id)));
    expect(e.status).toBe(404);
    expect((await db().from("memory_links").select("id").eq("id", expl.id)).data).toHaveLength(1);

    await removeAutoLink(Number(auto.id));
    expect((await db().from("memory_links").select("id").eq("id", auto.id)).data).toHaveLength(0);
  });

  it("recent list honours namespace + author filters and excludes retired rows", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const keep = await put(`list-${runId}`, `listed ${runId}`);
    const gone = await put(`list-gone-${runId}`, `retired ${runId}`);
    await retireMemory(gone.id);
    const res = await searchMemories({ q: "", namespace: space, author: "claude", machine: machineName() });
    const ids = res.rows.map((r) => r.id);
    expect(res.mode).toBe("recent");
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(gone.id);
    expect(res.rows.every((r) => r.namespace === space || r.namespace.startsWith(`${space}/`))).toBe(true);
    const none = await searchMemories({ q: "", namespace: space, author: "codex", machine: "" });
    expect(none.rows).toHaveLength(0);
  });

  it("search (FTS/hybrid) finds a memory by its run id", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const m = await put(`find-${runId}`, `zebra quokka ${runId}`);
    const res = await searchMemories({ q: `quokka ${runId}`, namespace: space, author: "", machine: "" });
    expect(res.mode).toBe("search");
    expect(res.rows.map((r) => r.id)).toContain(m.id);
  });
});
