import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db";
import { scopesForRole } from "./scopes";
import { ADMIN_TOKEN_PREFIX, AGENTS, LEAD_AGENTS, TOKEN_PREFIX } from "./config";
import { ROLES, type AgentCtx, type AgentId, type Role } from "./types";

type AuthCtx = Omit<AgentCtx, "flags" | "route">;

// Agent token = `${TOKEN_PREFIX}_<agent>_<43 base64url>`; admin token = `${ADMIN_TOKEN_PREFIX}<43 base64url>`.
const AGENT_TOKEN_RE = new RegExp(`^${TOKEN_PREFIX}_(${AGENTS.join("|")})_[A-Za-z0-9_-]{43}$`);

// Stored/displayed token_prefix = prefix + agent + separators + 4 random chars; derived, never a magic length,
// so it stays meaningful if TOKEN_PREFIX or the agent set changes.
export function tokenPrefixLength(agent: AgentId): number {
  return `${TOKEN_PREFIX}_${agent}_`.length + 4;
}

export function sha256hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export function newAgentToken(agent: AgentId): { raw: string; hash: string; prefix: string } {
  const raw = `${TOKEN_PREFIX}_${agent}_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256hex(raw), prefix: raw.slice(0, tokenPrefixLength(agent)) };
}

export function newAdminToken(): { raw: string; hash: string } {
  const raw = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256hex(raw) };
}

interface ResolvedToken {
  token_id: string;
  agent: string;
  device_id: string | null;
  machine: string | null;
  token_revoked: boolean;
  device_revoked: boolean;
  role: string | null;
  grants: string[] | null;
  assigned: string[] | null;
  confidential: string[] | null;
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// Role, grants and scopes are resolved on EVERY request (CONTRACT §11): one RPC round trip, no caching.
export async function authenticateTokenDetailed(
  raw: string,
): Promise<{ ctx: AuthCtx } | { error: "UNAUTHORIZED" | "REVOKED" }> {
  if (!AGENT_TOKEN_RE.test(raw)) return { error: "UNAUTHORIZED" }; // no DB hit for junk
  const { data, error } = await db().rpc("hub_resolve_token", { p_hash: sha256hex(raw), p_lead_agents: [...LEAD_AGENTS] });
  if (error) throw error;
  const r = data as ResolvedToken | null;
  if (!r || typeof r !== "object" || !r.token_id) return { error: "UNAUTHORIZED" };
  if (r.token_revoked || r.device_revoked) return { error: "REVOKED" };
  if (!AGENTS.includes(r.agent)) return { error: "UNAUTHORIZED" };
  const agent = r.agent as AgentId;
  // Fail closed: an unexpected role value from the DB gets least privilege, never more.
  const role: Role = (ROLES as readonly string[]).includes(r.role ?? "") ? (r.role as Role) : "member";
  const machine = r.machine ?? null;
  const s = scopesForRole(agent, role, strArr(r.assigned));
  return {
    ctx: {
      kind: "agent",
      tokenId: r.token_id,
      agent,
      deviceId: r.device_id ?? null,
      machine,
      ident: machine ? `${agent}@${machine}` : agent,
      role,
      grants: strArr(r.grants),
      confidential: strArr(r.confidential),
      readNs: s.readNs,
      writeNs: s.writeNs,
      inboxOnly: s.inboxOnly,
    },
  };
}

export async function authenticateToken(raw: string): Promise<AuthCtx | null> {
  try {
    const r = await authenticateTokenDetailed(raw);
    return "ctx" in r ? r.ctx : null;
  } catch {
    return null;
  }
}

export function isAdminToken(raw: string): boolean {
  const expected = process.env.ADMIN_TOKEN_HASH;
  if (!expected || !raw.startsWith(ADMIN_TOKEN_PREFIX)) return false;
  const a = Buffer.from(sha256hex(raw), "hex");
  const b = Buffer.from(expected.trim().toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
