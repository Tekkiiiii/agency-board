import { db } from "../db";
import { embed, EMBED_MODEL } from "../embed";
import { assertConfidentialTiers, instructionLike, CONFIDENTIAL_SLUG, tierHit, tierReadable } from "../guard";
import { inboxApprove, inboxList, inboxReject, kebab } from "../handlers";
import { confidentialSlugs } from "../roles";
import { confSlug, NAMESPACE_RE, SLUG_RE } from "../scopes";
import { ApiError, type LinkRelation } from "../types";

// B-MEMORY (§18): admin-side memory browser + curation. Server-only (service role via lib/db).
// Admin sees everything: read_patterns ['*'], granted = every confidential slug (§12).

/* eslint-disable @typescript-eslint/no-explicit-any */

export const ADMIN_ACTOR = "owner";
export const EDITED_FLAG = "edited-by-owner";
const LIST_LIMIT = 50;
const MAX_CONTENT = 8192;
const PREVIEW_CHARS = 280;

const MEM_COLS =
  "id,namespace,slug,content,tags,author_agent,author_device,target_namespace,review_status,approved_by,pinned,flags,embed_model,created_at,updated_at,deleted_at";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface MemoryRow {
  id: string;
  namespace: string;
  slug: string;
  content: string;
  tags: string[];
  author_agent: string;
  author_device: string | null;
  target_namespace: string | null;
  review_status: string | null;
  approved_by: string | null;
  pinned: boolean;
  flags: string[];
  embed_model: string | null;
  created_at: string;
  updated_at: string | null;
  deleted_at: string | null;
  score?: number | null;
  /** Confidential project slug of the namespace (null = not confidential). */
  confSlug: string | null;
  /** Has an incoming supersedes link from a non-retired memory (hidden from agent recall). */
  superseded?: boolean;
}

export interface MemoryFilters {
  q: string;
  namespace: string; // a namespace (prefix match) or a scope pattern ending in /*
  author: string; // agent id
  machine: string; // author_device
}

export interface LinkView {
  linkId: number;
  relation: LinkRelation;
  direction: "out" | "in";
  auto: boolean;
  score: number | null;
  createdBy: string;
  /** null when the link is dangling (target slug not written yet). */
  other: { id: string; namespace: string; slug: string; deleted: boolean; confSlug: string | null } | null;
  dangling: { namespace: string | null; slug: string } | null;
}

export interface MemoryDetail {
  memory: MemoryRow;
  links: Array<{ relation: LinkRelation; out: LinkView[]; in: LinkView[] }>;
}

// ------------------------------- pure helpers -------------------------------

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();

export function parseFilters(sp: Record<string, string | string[] | undefined>): MemoryFilters {
  return {
    q: one(sp.q).slice(0, 1000),
    namespace: one(sp.namespace).toLowerCase().slice(0, 102),
    author: one(sp.author).toLowerCase().slice(0, 20),
    machine: one(sp.machine).slice(0, 80),
  };
}

/** Namespace filter -> hub_search scope pattern. `a/b` -> `a/b/*` (a/b and everything below). null = invalid/empty. */
export function nsPattern(input: string): string | null {
  const s = input.trim().replace(/\/+$/, "");
  if (!s) return null;
  if (s === "*") return "*";
  const base = s.endsWith("/*") ? s.slice(0, -2) : s;
  return NAMESPACE_RE.test(base) ? `${base}/*` : null;
}

export function matchesAuthor(row: { author_agent: string; author_device: string | null }, f: Pick<MemoryFilters, "author" | "machine">): boolean {
  if (f.author && row.author_agent !== f.author) return false;
  if (f.machine && (row.author_device ?? "") !== f.machine) return false;
  return true;
}

/** Single-line preview as plain text; React escapes it on render (never raw HTML). */
export function preview(content: string, max = PREVIEW_CHARS): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Slug for an edited version: `<base>-v<n>` where base drops an existing `-v<k>` suffix and n is the
 * smallest number >= max(2, k+1) not in `taken`. Non-kebab slugs are kebab-cased first. Fits SLUG_RE (<= 80 chars).
 */
export function nextVersionSlug(oldSlug: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const under = oldSlug.startsWith("_") ? "_" : "";
  let body = under ? oldSlug.slice(1) : oldSlug;
  if (!/^[a-z0-9-]{1,80}$/.test(body)) body = kebab(body);
  const m = body.match(/^(.+?)-v(\d{1,6})$/);
  const base = m ? m[1] : body;
  let n = m ? Math.max(2, Number(m[2]) + 1) : 2;
  for (;;) {
    const suffix = `-v${n}`;
    const room = 80 - under.length - suffix.length;
    const b = base.slice(0, room).replace(/-+$/, "") || "memory";
    const s = `${under}${b}${suffix}`;
    if (!used.has(s)) return s;
    n++;
  }
}

/** Base of the version family (`foo-v3` -> `foo`), used to look up taken version slugs. */
export function versionBase(oldSlug: string): string {
  return nextVersionSlug(oldSlug).replace(/-v\d+$/, "");
}

/** Flags of an edited copy: original flags, instruction-like recomputed on the new content, + edited-by-owner. */
export function editedFlags(orig: string[], content: string): string[] {
  const out = orig.filter((f) => f !== "instruction-like" && f !== EDITED_FLAG);
  if (instructionLike(content)) out.push("instruction-like");
  out.push(EDITED_FLAG);
  return out;
}

const RELATION_ORDER: LinkRelation[] = ["supersedes", "part_of", "about_project", "relates_to"];

/** Groups links by relation (fixed order), explicit before auto, then by score desc. */
export function groupLinks(views: LinkView[]): MemoryDetail["links"] {
  const by = new Map<LinkRelation, { out: LinkView[]; in: LinkView[] }>();
  for (const v of views) {
    const g = by.get(v.relation) ?? { out: [], in: [] };
    g[v.direction].push(v);
    by.set(v.relation, g);
  }
  const rank = (r: LinkRelation) => {
    const i = RELATION_ORDER.indexOf(r);
    return i < 0 ? RELATION_ORDER.length : i;
  };
  const sortV = (a: LinkView, b: LinkView) => Number(a.auto) - Number(b.auto) || (b.score ?? 0) - (a.score ?? 0);
  return [...by.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([relation, g]) => ({ relation, out: g.out.sort(sortV), in: g.in.sort(sortV) }));
}

/** Readable, content-free message for any error raised by a memory action. */
export function readableError(e: unknown): string {
  // §13 / §13.5 tier hit (all 5 codes) from the JS guard or the DB trigger (`<CODE>:<rule>`); never content.
  const tier = tierHit(e);
  if (tier) return tierReadable(tier);
  if (e instanceof ApiError) return e.message;
  const code = (e as { code?: unknown })?.code;
  if ((e as { name?: string })?.name === "ZodError") return "Invalid input.";
  if (code === "PGRST202" || code === "PGRST205" || code === "42P01" || code === "42883") {
    return "The database is missing the roles/grants migration (20261007000002). Apply it and retry.";
  }
  return `Something went wrong (code ${String(code ?? "unknown")}). Nothing was changed if this happened before the save.`;
}

// ------------------------------- reads -------------------------------

async function run<T = any>(p: PromiseLike<{ data: any; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

function toRow(r: any, slugs: string[]): MemoryRow {
  return {
    id: r.id,
    namespace: r.namespace,
    slug: r.slug,
    content: r.content ?? "",
    tags: r.tags ?? [],
    author_agent: r.author_agent,
    author_device: r.author_device ?? null,
    target_namespace: r.target_namespace ?? null,
    review_status: r.review_status ?? null,
    approved_by: r.approved_by ?? null,
    pinned: !!r.pinned,
    flags: r.flags ?? [],
    embed_model: r.embed_model ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at ?? null,
    deleted_at: r.deleted_at ?? null,
    score: r.score ?? null,
    confSlug: confSlug(r.namespace, slugs),
  };
}

// Marks rows that a live (non-retired) newer version supersedes. One query over the listed ids.
async function markSuperseded(rows: MemoryRow[]): Promise<MemoryRow[]> {
  if (!rows.length) return rows;
  const links: any[] =
    (await run(db().from("memory_links").select("from_id,to_id").eq("relation", "supersedes").in("to_id", rows.map((r) => r.id)))) ?? [];
  if (!links.length) return rows;
  const live: any[] = (await run(db().from("memories").select("id").in("id", [...new Set(links.map((l) => l.from_id))]).is("deleted_at", null))) ?? [];
  const liveIds = new Set(live.map((m) => m.id));
  const hidden = new Set(links.filter((l) => liveIds.has(l.from_id)).map((l) => l.to_id));
  return rows.map((r) => (hidden.has(r.id) ? { ...r, superseded: true } : r));
}

export interface SearchResult {
  mode: "search" | "recent";
  rows: MemoryRow[];
  /** true when the query embedding failed and only full-text search ran. */
  ftsOnly: boolean;
  invalidNamespace: boolean;
}

/** Hybrid search as admin (q set) or the 50 newest non-deleted memories (q empty). */
export async function searchMemories(f: MemoryFilters): Promise<SearchResult> {
  const slugs = await confidentialSlugs();
  const pattern = nsPattern(f.namespace);
  const invalidNamespace = f.namespace !== "" && pattern === null;

  if (f.q) {
    const vec = (await embed([f.q]))?.[0] ?? null; // null -> FTS only
    const rows: any[] =
      (await run(
        db().rpc("hub_search", {
          q_embedding: vec,
          q_text: f.q,
          read_patterns: ["*"],
          caller_agent: ADMIN_ACTOR,
          ns_filter: pattern,
          k: LIST_LIMIT,
          q_model: EMBED_MODEL,
          granted: slugs,
        }),
      )) ?? [];
    // hub_search omits pinned/target/approved_by/deleted_at: fill them from the table in one query.
    const ids = rows.map((r) => r.id);
    const full: any[] = ids.length ? ((await run(db().from("memories").select(MEM_COLS).in("id", ids))) ?? []) : [];
    const byId = new Map(full.map((r) => [r.id, r]));
    const out = rows.map((r) => toRow({ ...r, ...(byId.get(r.id) ?? {}), score: r.score }, slugs)).filter((r) => matchesAuthor(r, f));
    return { mode: "search", rows: await markSuperseded(out), ftsOnly: vec === null, invalidNamespace };
  }

  let q = db().from("memories").select(MEM_COLS).is("deleted_at", null).order("created_at", { ascending: false }).limit(LIST_LIMIT);
  if (pattern && pattern !== "*") {
    const base = pattern.slice(0, -2);
    q = q.or(`namespace.eq.${base},namespace.like.${base}/%`);
  }
  if (f.author) q = q.eq("author_agent", f.author);
  if (f.machine) q = q.eq("author_device", f.machine);
  const rows: any[] = (await run(q)) ?? [];
  return { mode: "recent", rows: await markSuperseded(rows.map((r) => toRow(r, slugs))), ftsOnly: false, invalidNamespace };
}

/** Distinct authors / machines for the filter dropdowns (data-derived, never invented). */
export async function filterOptions(): Promise<{ authors: string[]; machines: string[] }> {
  const rows: any[] =
    (await run(db().from("memories").select("author_agent,author_device").is("deleted_at", null).order("created_at", { ascending: false }).limit(1000))) ?? [];
  const authors = [...new Set(rows.map((r) => r.author_agent as string))].sort();
  const machines = [...new Set(rows.map((r) => r.author_device as string | null).filter((m): m is string => !!m))].sort();
  return { authors, machines };
}

/** Memory (including retired) + every incoming/outgoing link, read directly as admin. */
export async function getMemoryDetail(id: string): Promise<MemoryDetail | null> {
  if (!UUID_RE.test(id)) return null;
  const slugs = await confidentialSlugs();
  const m = await run(db().from("memories").select(MEM_COLS).eq("id", id).maybeSingle());
  if (!m) return null;
  const edges: any[] =
    (await run(
      db().from("memory_links").select("id,from_id,to_id,to_slug,to_namespace,relation,auto,score,created_by").or(`from_id.eq.${id},to_id.eq.${id}`).limit(500),
    )) ?? [];
  const otherIds = [...new Set(edges.map((e) => (e.from_id === id ? e.to_id : e.from_id)).filter((x): x is string => !!x && x !== id))];
  const others: any[] = otherIds.length ? ((await run(db().from("memories").select("id,namespace,slug,deleted_at").in("id", otherIds))) ?? []) : [];
  const byId = new Map(others.map((o) => [o.id, o]));
  const views: LinkView[] = edges.map((e) => {
    const direction: "out" | "in" = e.from_id === id ? "out" : "in";
    const otherId: string | null = direction === "out" ? e.to_id : e.from_id;
    const o = otherId ? byId.get(otherId) : null;
    return {
      linkId: Number(e.id),
      relation: e.relation,
      direction,
      auto: !!e.auto,
      score: e.score ?? null,
      createdBy: e.created_by,
      other: o ? { id: o.id, namespace: o.namespace, slug: o.slug, deleted: !!o.deleted_at, confSlug: confSlug(o.namespace, slugs) } : null,
      dangling: !otherId ? { namespace: e.to_namespace ?? null, slug: e.to_slug } : null,
    };
  });
  return { memory: toRow(m, slugs), links: groupLinks(views) };
}

// ------------------------------- mutations -------------------------------

const notFound = (what: string) => new ApiError(404, "NOT_FOUND", `${what} not found`);
const now = () => new Date().toISOString();

function vId(id: string): string {
  if (!UUID_RE.test(id)) throw new ApiError(422, "VALIDATION", "Invalid id");
  return id;
}

export interface EditResult {
  id: string;
  namespace: string;
  slug: string;
  embedded: boolean;
  auto_links: number;
}

/**
 * Edit = a new row (same namespace, slug `<old>-v<n>`, author copied, approved_by owner, flags + edited-by-owner)
 * + a `supersedes` link new -> old (which hides the old row from recall) + embed + hub_autolink.
 * The confidential tier guard (§13: PII never, contracts only in confidential) runs in JS before the insert and again in the DB trigger.
 */
export async function editMemory(input: { id: string; content: string }): Promise<EditResult> {
  const id = vId(input.id);
  const content = input.content.replace(/\r\n/g, "\n");
  if (!content.trim()) throw new ApiError(422, "VALIDATION", "Content cannot be empty");
  if (content.length > MAX_CONTENT) throw new ApiError(422, "VALIDATION", `Content is limited to ${MAX_CONTENT} characters`);

  const old = await run(db().from("memories").select(MEM_COLS).eq("id", id).maybeSingle());
  if (!old || old.deleted_at) throw notFound("Memory");
  if (old.namespace === "shared/inbox") throw new ApiError(422, "VALIDATION", "Inbox items are reviewed in the Inbox tab, not edited");

  const slugs = await confidentialSlugs();
  // Admin holds every grant, so the namespace alone decides contracts; PII is blocked everywhere (§13.3). Contracts only
  // matter in confidential context (namespace project/confidential* or a confidential marker, incl. the row's slug/tags like the DB trigger).
  assertConfidentialTiers(
    { ok: confSlug(old.namespace, slugs) === CONFIDENTIAL_SLUG, ns: old.namespace, context: [old.slug, ...(old.tags ?? [])] },
    content,
  );

  const taken: any[] =
    (await run(db().from("memories").select("slug").eq("namespace", old.namespace).like("slug", `${versionBase(old.slug)}-v%`).limit(1000))) ?? [];
  const used = new Set<string>(taken.map((t) => t.slug));

  let row: any = null;
  for (let i = 0; i < 5 && !row; i++) {
    const slug = nextVersionSlug(old.slug, used);
    if (!SLUG_RE.test(slug)) throw new ApiError(422, "VALIDATION", "Could not derive a valid slug");
    const { data, error } = await db()
      .from("memories")
      .insert({
        namespace: old.namespace,
        slug,
        content,
        tags: old.tags ?? [],
        author_agent: old.author_agent,
        author_device: old.author_device,
        author_token: null,
        approved_by: ADMIN_ACTOR,
        review_status: null,
        pinned: !!old.pinned,
        flags: editedFlags(old.flags ?? [], content),
      })
      .select("id,namespace,slug")
      .single();
    if (!error) row = data;
    else if (error.code === "23505") used.add(slug);
    else throw error; // <TIER_CODE>:<rule> from the trigger (§13/§13.5, 5 codes) -> readableError()
  }
  if (!row) throw new ApiError(409, "CONFLICT", "Could not allocate a unique version slug");

  await run(db().from("memory_links").insert({ from_id: row.id, to_id: old.id, relation: "supersedes", created_by: ADMIN_ACTOR, auto: false }));

  let embedded = false;
  let auto_links = 0;
  const vec = (await embed([content]))?.[0];
  if (vec) {
    try {
      await run(db().from("memories").update({ embedding: vec, embed_model: EMBED_MODEL }).eq("id", row.id));
      embedded = true;
      const n = await run(db().rpc("hub_autolink", { p_id: row.id, read_patterns: ["*"], granted: slugs }));
      auto_links = typeof n === "number" ? n : 0;
    } catch (e) {
      console.error("[hub] dash edit embed/autolink failed", row.id, String((e as { code?: string })?.code ?? "unknown"));
    }
  } else {
    console.error("[hub] EMBED_FAILED", row.id); // daily cron backfills
  }
  return { id: row.id, namespace: row.namespace, slug: row.slug, embedded, auto_links };
}

/** Soft delete. Returns false when it was already retired. */
export async function retireMemory(id: string): Promise<boolean> {
  const t = now();
  const rows: any[] = (await run(db().from("memories").update({ deleted_at: t, updated_at: t }).eq("id", vId(id)).is("deleted_at", null).select("id"))) ?? [];
  if (rows.length) return true;
  const exists = await run(db().from("memories").select("id").eq("id", id).maybeSingle());
  if (!exists) throw notFound("Memory");
  return false;
}

export async function setPinned(id: string, pinned: boolean): Promise<void> {
  const rows: any[] = (await run(db().from("memories").update({ pinned, updated_at: now() }).eq("id", vId(id)).is("deleted_at", null).select("id"))) ?? [];
  if (!rows.length) throw notFound("Memory");
}

/** Deletes a memory_links row only if it is an AUTO link (explicit links are never removed here). */
export async function removeAutoLink(linkId: number): Promise<void> {
  if (!Number.isSafeInteger(linkId) || linkId <= 0) throw new ApiError(422, "VALIDATION", "Invalid link id");
  const rows: any[] = (await run(db().from("memory_links").delete().eq("id", linkId).eq("auto", true).select("id"))) ?? [];
  if (!rows.length) throw notFound("Auto link");
}

// ------------------------------- inbox -------------------------------

export async function listInbox(): Promise<MemoryRow[]> {
  const rows: any[] = await inboxList();
  return rows.map((r) => toRow(r, []));
}

export async function approveInboxItem(id: string, namespace?: string): Promise<{ id: string; namespace: string; slug: string }> {
  const r: any = await inboxApprove({ id: vId(id), ...(namespace ? { namespace } : {}) }, { actor: ADMIN_ACTOR });
  return { id: r.id, namespace: r.namespace, slug: r.slug };
}

export async function rejectInboxItem(id: string): Promise<void> {
  await inboxReject({ id: vId(id) }, { actor: ADMIN_ACTOR });
}
