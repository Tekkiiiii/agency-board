import { isRestricted } from "./config";
import { ApiError, type AgentCtx, type AgentId, type Role } from "./types";

// Max 100 chars enforced by the lookahead so callers can't forget it.
export const NAMESPACE_RE = /^(?=.{1,100}$)[a-z0-9-]+(\/[a-z0-9-]+)*$/;
export const SLUG_RE = /^_?[a-z0-9-]{1,80}$/;

// Same semantics as SQL hub_ns_match: '*' all; 'a/b' exact; 'a/*' = 'a' or anything under 'a/'.
export function nsMatch(ns: string, patterns: string[]): boolean {
  return patterns.some((p) => {
    if (p === "*" || p === ns) return true;
    if (!p.endsWith("/*")) return false;
    const base = p.slice(0, -2);
    return ns === base || ns.startsWith(base + "/");
  });
}

// CONTRACT §11. Scopes are derived per request from the role of agent@machine; nothing is stored per token.
export function scopesForRole(
  agent: AgentId,
  role: Role,
  assigned: string[],
): { readNs: string[]; writeNs: string[]; inboxOnly: boolean } {
  const extra = Array.from(new Set(assigned ?? []));
  // Restricted-agent cap (AGENCY_BOARD_RESTRICTED_AGENTS): at ANY role (e.g. a provider that may log prompts). Role still
  // governs dispatch/review/forget.
  if (isRestricted(agent)) {
    return { readNs: dedupe([`${agent}/*`, "shared/inbox", ...extra]), writeNs: ["shared/inbox"], inboxOnly: true };
  }
  if (role === "director" || role === "lead") return { readNs: ["*"], writeNs: ["*"], inboxOnly: false };
  return { readNs: dedupe(["shared/*", `${agent}/*`, ...extra]), writeNs: [`${agent}/*`, "shared/inbox"], inboxOnly: false };
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

// Pure mirror of SQL hub_conf_slug given the confidential slug list.
export function confSlug(ns: string, confidential: string[]): string | null {
  const [first, second] = ns.split("/");
  if (first !== "project" || second === undefined) return null;
  return confidential.includes(second) ? second : null;
}

// CONTRACT §11 dispatch (post_task handoff_to, handoff): target roles each role may dispatch to. A lead's target must
// have EVERY matching identity in this list. Member: none, except handing a task back to its assigned_by; handing work
// UPWARD (every target identity outranks the caller) is always allowed (§13.4). Used by handlers and lib/guide.ts.
export const DISPATCH_TO: Readonly<Record<Role, readonly Role[]>> = {
  director: ["director", "lead", "member"],
  lead: ["lead", "member"],
  member: [],
};

// Default role comes from config (AGENCY_BOARD_LEAD_AGENTS); re-exported so existing imports keep working.
export { defaultRole } from "./config";

// Accepts any AgentCtx (a structural subset so pre-flags auth ctx works too).
type ScopeCtx = Pick<AgentCtx, "readNs" | "writeNs" | "grants" | "confidential">;

export function canRead(ctx: ScopeCtx, ns: string): boolean {
  if (!nsMatch(ns, ctx.readNs)) return false;
  const slug = confSlug(ns, ctx.confidential);
  return slug === null || ctx.grants.includes(slug);
}

export function canWrite(ctx: ScopeCtx, ns: string): void {
  if (!nsMatch(ns, ctx.writeNs)) {
    throw new ApiError(403, "SCOPE_DENIED", "Namespace not in your scope", { allowed: ctx.writeNs });
  }
  const slug = confSlug(ns, ctx.confidential);
  if (slug !== null && !ctx.grants.includes(slug)) {
    throw new ApiError(403, "GRANT_REQUIRED", "Confidential project requires a grant", { project: slug });
  }
}
