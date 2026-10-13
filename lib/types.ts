// Agent ids are configured at deploy time (AGENCY_BOARD_AGENTS, see lib/config.ts). The type is a plain string; membership is
// validated at runtime by isAgentId() / zod refine, and the DB only checks the id format.
export type AgentId = string;
export { AGENTS } from "./config";
export type LinkRelation = "relates_to" | "supersedes" | "part_of" | "about_project";
export type TaskStatus = "open" | "claimed" | "blocked" | "done" | "failed" | "cancelled";
export type Role = "director" | "lead" | "member";
export const ROLES: readonly Role[] = ["director", "lead", "member"] as const;

export interface Flags { dispatchPaused: boolean; writesFrozen: boolean }

export interface AgentCtx {
  kind: "agent";
  tokenId: string;
  agent: AgentId;
  deviceId: string | null;
  machine: string | null;          // devices.machine_name
  ident: string;                   // `${agent}@${machine}` (or agent when machine null)
  role: Role;
  grants: string[];                // confidential project slugs granted to this identity
  confidential: string[];          // ALL confidential slugs, read in the same per-request RPC
  // readNs/writeNs/inboxOnly are DERIVED per request from role (+ restricted-agent cap, + assigned)
  readNs: string[];
  writeNs: string[];
  inboxOnly: boolean;
  flags: Flags;
  route: string;                   // set via setRoute(); used by access log
}

export interface AdminCtx { kind: "admin"; route: string }

export interface RequestMeta {
  ip: string | null; country: string | null; city: string | null;
  asn: number | null; network: string | null; client: string | null; at: Date;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export interface Provenance {
  id: string; namespace: string; slug: string; author_agent: string; author_device: string | null;
  created_at: string; updated_at: string | null; flags: string[]; review_status: string | null;
}

export interface MemoryHit extends Provenance {
  content: string; score?: number;
  neighbors?: Array<Provenance & { relation: LinkRelation; direction: "out" | "in"; auto: boolean; depth: number; content: string }>;
}
