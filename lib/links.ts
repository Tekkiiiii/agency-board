import { db } from "./db";
import { canRead } from "./scopes";
import { ApiError, type AgentCtx, type LinkRelation } from "./types";

export interface LinkSpec { slug: string; namespace?: string; relation: LinkRelation }

// `[[slug]]` or `[[ns/path:slug]]`. Same char classes as NAMESPACE_RE / SLUG_RE.
const WIKI_RE = /\[\[(?:([a-z0-9-]+(?:\/[a-z0-9-]+)*):)?(_?[a-z0-9-]{1,80})\]\]/g;

export function parseWikiLinks(content: string): LinkSpec[] {
  const out: LinkSpec[] = [];
  for (const m of content.matchAll(WIKI_RE)) {
    out.push({ slug: m[2], namespace: m[1] || undefined, relation: "relates_to" });
    if (out.length >= 50) break; // ponytail: hard cap; nobody links 50 things from one memory
  }
  return out;
}

type VisRow = { id: string; namespace: string; author_agent: string; review_status: string | null; deleted_at: string | null };

// Scope + confidential grant (canRead, §12) + hub_visible (the single source of the visibility rule, §10).
export async function canSee(ctx: AgentCtx, row: VisRow | null): Promise<boolean> {
  if (!row || !canRead(ctx, row.namespace)) return false;
  const { data, error } = await db().rpc("hub_visible", {
    m: { id: row.id, author_agent: row.author_agent, review_status: row.review_status, deleted_at: row.deleted_at },
    caller_agent: ctx.agent,
  });
  if (error) throw error;
  return data === true;
}

export const VIS_COLS = "id,namespace,author_agent,review_status,deleted_at";

// agent@machine, resolved once per request by lib/auth (§15).
export function ident(ctx: AgentCtx): string {
  return ctx.ident;
}

// Explicit links from a fresh memory. Resolved now if the target exists AND the writer can see it;
// otherwise stored dangling (to_slug/to_namespace); canSee hides ungranted confidential targets (§12) — hub_resolve_links attaches it when the slug appears.
// Bare `[[slug]]` defaults to `defaultNs` (the namespace the writer asked for).
export async function insertLinks(ctx: AgentCtx, fromId: string, fromSlug: string, defaultNs: string, specs: LinkSpec[]): Promise<number> {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const s of specs) {
    const ns = s.namespace ?? defaultNs;
    const key = `${s.relation}|${ns}:${s.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { data, error } = await db().from("memories").select(VIS_COLS).eq("namespace", ns).eq("slug", s.slug).maybeSingle();
    if (error) throw error;
    if (data?.id === fromId) continue; // self link
    const base = { from_id: fromId, relation: s.relation, created_by: ident(ctx), auto: false };
    if (data && (await canSee(ctx, data as VisRow))) rows.push({ ...base, to_id: data.id });
    else if (!(ns === defaultNs && s.slug === fromSlug)) rows.push({ ...base, to_slug: s.slug, to_namespace: ns });
  }
  if (!rows.length) return 0;
  const { data, error } = await db().from("memory_links").insert(rows).select("id");
  if (error) {
    if (error.code === "23505") throw new ApiError(409, "CONFLICT", "Duplicate link");
    throw error;
  }
  return data?.length ?? 0;
}
