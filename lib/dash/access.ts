import { z } from "zod";
import { AGENTS, isRestricted } from "../config";
import { tierHit, tierReadable } from "../guard";
import { ROLES, type AgentId, type Role } from "../types";

// B-ACCESS (§12, §18): pure helpers for /dashboard/access and /dashboard/kill-switch.
// No DB access here — server actions validate with these schemas, then call lib/roles.ts, lib/flags.ts,
// lib/devices.ts. The client's checkbox state is never trusted: the desired boolean is passed explicitly
// and re-validated server-side.

export const PROJECT_SLUG_RE = /^[a-z0-9-]{1,40}$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const RESTRICTED_WARNING =
  "A restricted agent stays read/write capped at every role. Granting it a confidential project or a higher role needs explicit confirmation.";

// ------------------------------------------------------------------ input schemas

const agentSchema = z.string().refine((a): a is AgentId => (AGENTS as readonly string[]).includes(a), "unknown agent");
const deviceSchema = z.string().regex(UUID_RE, "device_id must be a uuid").transform((s) => s.toLowerCase());
const slugSchema = z.string().regex(PROJECT_SLUG_RE, "slug must be 1-40 characters: a-z, 0-9 and -");
const nameSchema = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "name is required").max(80, "name must be at most 80 characters"));

export const grantInputSchema = z.object({
  agent: agentSchema,
  device_id: deviceSchema,
  slug: slugSchema,
  granted: z.boolean(),
  // Ticking a restricted-agent cell needs the warning dialog; the server refuses such a grant without this ack.
  restricted_ack: z.boolean().optional(),
});
export type GrantInput = z.infer<typeof grantInputSchema>;

export const createProjectSchema = z.object({ slug: slugSchema, name: nameSchema });
export const renameProjectSchema = z.object({ slug: slugSchema, name: nameSchema });

export type FlagKey = "dispatch" | "writes";
export const flagInputSchema = z.object({
  flag: z.enum(["dispatch", "writes"]),
  on: z.enum(["true", "false"]).transform((v) => v === "true"),
  confirm: z.string().max(40),
});

export const revokeInputSchema = z.object({ agent: agentSchema, confirm: z.string().max(40) });

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

// First zod issue as a plain sentence (never echoes the input).
export function parseWith<T>(schema: z.ZodType<T>, raw: unknown): Parsed<T> {
  const r = schema.safeParse(raw);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  const field = issue?.path?.length ? `${issue.path.join(".")}: ` : "";
  return { ok: false, error: `${field}${issue?.message ?? "invalid input"}` };
}

// FormData -> plain object of string fields (files dropped).
export function formFields(fd: { forEach(cb: (value: unknown, key: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  fd.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

// A grant to a restricted agent must have gone through the warning dialog.
export function grantNeedsRestrictedAck(input: Pick<GrantInput, "agent" | "granted" | "restricted_ack">): boolean {
  return isRestricted(input.agent) && input.granted && input.restricted_ack !== true;
}

// ------------------------------------------------------------------ typed confirmations (kill switch)

// Turning a flag ON needs PAUSE / FREEZE; turning it OFF needs RESUME / UNFREEZE.
export function flagConfirmWord(flag: FlagKey, turnOn: boolean): string {
  if (flag === "dispatch") return turnOn ? "PAUSE" : "RESUME";
  return turnOn ? "FREEZE" : "UNFREEZE";
}

// Exact, case-sensitive match. Surrounding whitespace is forgiven (copy/paste), nothing else.
export function confirmMatches(expected: string, typed: unknown): boolean {
  return typeof typed === "string" && expected.length > 0 && typed.trim() === expected;
}

export function flagConfirmOk(flag: FlagKey, turnOn: boolean, typed: unknown): boolean {
  return confirmMatches(flagConfirmWord(flag, turnOn), typed);
}

// Revoking an agent needs the agent name typed exactly.
export function revokeConfirmOk(agent: AgentId, typed: unknown): boolean {
  return confirmMatches(agent, typed);
}

// ------------------------------------------------------------------ matrix model

export interface IdentityLike {
  agent: AgentId;
  device_id: string;
  machine: string;
  role: Role;
  role_is_default?: boolean;
  grants: string[];
  revoked: boolean;
}
export interface ProjectLike {
  slug: string;
  name: string;
  grant_count: number;
}

export interface MatrixCell {
  key: string; // `${agent}|${device_id}|${slug}`
  slug: string;
  checked: boolean;
}
export interface MatrixRow {
  key: string; // `${agent}|${device_id}`
  agent: AgentId;
  device_id: string;
  ident: string;
  role: Role;
  roleIsDefault: boolean;
  revoked: boolean;
  isRestricted: boolean;
  cells: MatrixCell[];
}
export interface MatrixColumn {
  slug: string;
  name: string;
  grantCount: number;
}
export interface MatrixModel {
  columns: MatrixColumn[];
  rows: MatrixRow[];
}

export function identLabel(agent: string, machine: string | null | undefined): string {
  return machine ? `${agent}@${machine}` : agent;
}

const ROLE_ORDER: Record<Role, number> = { director: 0, lead: 1, member: 2 };

// Rows = identities (active first, then by role, ident), columns = projects by slug.
// A cell is checked iff the identity's grants include the slug — nothing else turns a cell on.
export function buildMatrix(identities: IdentityLike[], projects: ProjectLike[]): MatrixModel {
  const columns = [...projects]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) => ({ slug: p.slug, name: p.name, grantCount: p.grant_count }));
  const rows = identities
    .filter((i) => (AGENTS as readonly string[]).includes(i.agent) && (ROLES as readonly string[]).includes(i.role))
    .map((i) => {
      const granted = new Set(i.grants);
      const rowKey = `${i.agent}|${i.device_id}`;
      return {
        key: rowKey,
        agent: i.agent,
        device_id: i.device_id,
        ident: identLabel(i.agent, i.machine),
        role: i.role,
        roleIsDefault: i.role_is_default ?? false,
        revoked: i.revoked,
        isRestricted: isRestricted(i.agent),
        cells: columns.map((c) => ({ key: `${rowKey}|${c.slug}`, slug: c.slug, checked: granted.has(c.slug) })),
      };
    })
    .sort(
      (a, b) =>
        Number(a.revoked) - Number(b.revoked) ||
        ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
        a.ident.localeCompare(b.ident),
    );
  return { columns, rows };
}

// aria-live status line text.
export function grantStatusMessage(granted: boolean, slug: string, ident: string): string {
  return granted ? `Granted ${slug} to ${ident}` : `Removed ${slug} from ${ident}`;
}

// ------------------------------------------------------------------ audit rows

export interface AuditView {
  id: string;
  at: string | null;
  actor: string;
  action: string;
  target: string;
  detail: string;
}

function detailText(d: unknown): string {
  if (d === null || d === undefined) return "";
  if (typeof d !== "object") return String(d);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    if (v === null || v === undefined || v === false) continue;
    parts.push(`${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  }
  const s = parts.join(", ");
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

// listAudit() returns unknown[]; shape it defensively for display.
export function toAuditView(rows: unknown[]): AuditView[] {
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      id: String(r.id ?? ""),
      at: typeof r.at === "string" ? r.at : null,
      actor: typeof r.actor === "string" ? r.actor : "owner",
      action: typeof r.action === "string" ? r.action : "unknown",
      target: typeof r.target === "string" ? r.target : "",
      detail: detailText(r.detail),
    }));
}

// ------------------------------------------------------------------ errors -> UI text

// Maps ApiError / Postgres errors to a short message; never echoes content or secrets.
export function actionErrorMessage(e: unknown): { status: number; message: string } {
  const err = (e ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof err.status === "number" ? err.status : 500;
  const code = typeof err.code === "string" ? err.code : "";
  // §13 / §13.5 tier hit (all 5 codes; e.g. a confidential project name) from ApiError or the DB trigger.
  const tier = tierHit(e);
  if (tier) return { status: 422, message: tierReadable(tier) };
  if (code === "VALIDATION") return { status, message: typeof err.message === "string" ? err.message : "Invalid input." };
  if (code === "CONFLICT") return { status, message: "That project already exists." };
  if (code === "NOT_FOUND") return { status, message: "Not found: the identity, device or project no longer exists." };
  if (code === "42P01" || code === "PGRST205" || code === "PGRST202")
    return { status: 500, message: "The roles/grants tables are missing: migration 20261007000002 is not applied yet." };
  return { status: 500, message: `The change was not saved${code ? ` (error ${code})` : ""}. Try again.` };
}
