import { db } from "./db";
import { assertConfidentialTiers } from "./guard";
import { AGENTS, defaultRole, LEAD_AGENTS } from "./config";
import { ApiError, ROLES, type AgentId, type Role } from "./types";

// CONTRACT §11/§12/§15. Admin-side role, grant and confidential-project management. No module caches:
// every call reads fresh so changes apply on the next request.

const PROJECT_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_RE = new RegExp(`^(${AGENTS.join("|")})(?:@([A-Za-z0-9._-]{1,80}))?$`);

type PgError = { code?: string; message?: string } | null;

function invalid(message: string): never {
  throw new ApiError(422, "VALIDATION", message);
}

function vAgent(agent: unknown): AgentId {
  if (typeof agent !== "string" || !AGENTS.includes(agent)) invalid(`agent must be one of ${AGENTS.join(",")}`);
  return agent as AgentId;
}
function vDevice(id: unknown): string {
  if (typeof id !== "string" || !UUID_RE.test(id)) invalid("device_id must be a uuid");
  return id.toLowerCase();
}
function vRole(role: unknown): Role {
  if (typeof role !== "string" || !(ROLES as readonly string[]).includes(role)) invalid(`role must be one of ${ROLES.join(",")}`);
  return role as Role;
}
function vSlug(slug: unknown): string {
  if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) invalid("slug must match ^[a-z0-9-]{1,40}$");
  return slug;
}
function vName(name: unknown): string {
  const n = typeof name === "string" ? name.trim() : "";
  if (n.length < 1 || n.length > 80) invalid("name must be 1-80 characters");
  return n;
}

// Postgres -> API errors. Anything unmapped is rethrown and surfaces as 500 INTERNAL (code logged only).
function pg(error: PgError, what: string): void {
  if (!error) return;
  const code = error.code ?? "";
  const msg = error.message ?? "";
  if (code === "23505") throw new ApiError(409, "CONFLICT", `${what}: already exists`);
  if (code === "23503") throw new ApiError(404, "NOT_FOUND", `${what}: referenced device or project not found`);
  if (code === "22023" && msg.includes("UNKNOWN_PROJECT")) throw new ApiError(404, "NOT_FOUND", `${what}: unknown project`);
  if (code === "22023") throw new ApiError(422, "VALIDATION", `${what}: invalid argument`);
  throw error;
}

async function audit(action: "project_create" | "project_rename", target: string, detail: Record<string, unknown>): Promise<void> {
  const { error } = await db().from("admin_audit").insert({ action, target, detail });
  pg(error, "audit");
}

export async function confidentialSlugs(): Promise<string[]> {
  const { data, error } = await db().from("confidential_projects").select("slug").order("slug");
  pg(error, "confidential projects");
  return ((data ?? []) as Array<{ slug: string }>).map((r) => r.slug);
}

export interface IdentityRow {
  agent: AgentId;
  device_id: string;
  machine: string;
  role: Role;
  role_is_default: boolean;
  grants: string[];
  token_prefix: string | null;
  model: string | null;
  status_note: string | null;
  last_heartbeat_at: string | null;
  last_used_at: string | null;
  current_task_id: string | null;
  revoked: boolean;
}

type LiveToken = {
  agent: AgentId; device_id: string; token_prefix: string; model: string | null; status_note: string | null;
  last_heartbeat_at: string | null; last_used_at: string | null; current_task_id: string | null; created_at: string;
};

// One row per (agent, device) with a non-revoked token OR an agent_roles row. Four parallel queries, no N+1.
export async function listIdentities(): Promise<IdentityRow[]> {
  const [tok, roles, grants, devs] = await Promise.all([
    db()
      .from("agent_tokens")
      .select("agent, device_id, token_prefix, model, status_note, last_heartbeat_at, last_used_at, current_task_id, created_at")
      .is("revoked_at", null)
      .not("device_id", "is", null),
    db().from("agent_roles").select("agent, device_id, role"),
    db().from("grants").select("agent, device_id, project_slug"),
    db().from("devices").select("id, machine_name, revoked_at"),
  ]);
  pg(tok.error, "list tokens");
  pg(roles.error, "list roles");
  pg(grants.error, "list grants");
  pg(devs.error, "list devices");

  const key = (agent: string, device: string) => `${agent}|${device}`;
  const devices = new Map(
    ((devs.data ?? []) as Array<{ id: string; machine_name: string; revoked_at: string | null }>).map((d) => [d.id, d]),
  );

  const live = new Map<string, LiveToken>(); // newest non-revoked token per identity
  for (const t of (tok.data ?? []) as LiveToken[]) {
    const k = key(t.agent, t.device_id);
    const cur = live.get(k);
    if (!cur || t.created_at > cur.created_at) live.set(k, t);
  }
  const roleOf = new Map(
    ((roles.data ?? []) as Array<{ agent: AgentId; device_id: string; role: Role }>).map((r) => [key(r.agent, r.device_id), r.role]),
  );
  const grantsOf = new Map<string, string[]>();
  for (const g of (grants.data ?? []) as Array<{ agent: string; device_id: string; project_slug: string }>) {
    const k = key(g.agent, g.device_id);
    grantsOf.set(k, [...(grantsOf.get(k) ?? []), g.project_slug]);
  }

  const keys = new Set<string>([...live.keys(), ...roleOf.keys()]);
  const out: IdentityRow[] = [];
  for (const k of keys) {
    const [agent, deviceId] = k.split("|") as [AgentId, string];
    const t = live.get(k);
    const dev = devices.get(deviceId);
    const stored = roleOf.get(k);
    out.push({
      agent,
      device_id: deviceId,
      machine: dev?.machine_name ?? "",
      role: stored ?? defaultRole(agent),
      role_is_default: stored === undefined,
      grants: (grantsOf.get(k) ?? []).sort(),
      token_prefix: t?.token_prefix ?? null,
      model: t?.model ?? null,
      status_note: t?.status_note ?? null,
      last_heartbeat_at: t?.last_heartbeat_at ?? null,
      last_used_at: t?.last_used_at ?? null,
      current_task_id: t?.current_task_id ?? null,
      revoked: !t || !!dev?.revoked_at,
    });
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine) || a.agent.localeCompare(b.agent));
}

export async function setRole(
  agent: AgentId,
  deviceId: string,
  role: Role,
): Promise<{ agent: AgentId; device_id: string; role: Role; demoted: string | null }> {
  const a = vAgent(agent);
  const d = vDevice(deviceId);
  const r = vRole(role);
  const { data, error } = await db().rpc("hub_set_role", { p_agent: a, p_device: d, p_role: r, p_lead_agents: [...LEAD_AGENTS] });
  pg(error, "set role");
  const res = (data ?? {}) as { demoted?: string | null };
  return { agent: a, device_id: d, role: r, demoted: res.demoted ?? null };
}

export async function listProjects(): Promise<Array<{ slug: string; name: string; created_at: string; grant_count: number }>> {
  const [proj, grants] = await Promise.all([
    db().from("confidential_projects").select("slug, name, created_at").order("slug"),
    db().from("grants").select("project_slug"),
  ]);
  pg(proj.error, "list projects");
  pg(grants.error, "list grants");
  const counts = new Map<string, number>();
  for (const g of (grants.data ?? []) as Array<{ project_slug: string }>) counts.set(g.project_slug, (counts.get(g.project_slug) ?? 0) + 1);
  return ((proj.data ?? []) as Array<{ slug: string; name: string; created_at: string }>).map((p) => ({
    ...p,
    grant_count: counts.get(p.slug) ?? 0,
  }));
}

export async function createProject(slug: string, name: string): Promise<{ slug: string; name: string }> {
  const s = vSlug(slug);
  const n = vName(name);
  assertConfidentialTiers({ ok: false }, n); // §13: a project name is free text shown everywhere; never customer PII or confidential contract wording
  const { error } = await db().from("confidential_projects").insert({ slug: s, name: n });
  pg(error, "create project");
  await audit("project_create", s, { name: n });
  return { slug: s, name: n };
}

// Slug is immutable (§12); only the display name changes.
export async function renameProject(slug: string, name: string): Promise<{ slug: string; name: string }> {
  const s = vSlug(slug);
  const n = vName(name);
  assertConfidentialTiers({ ok: false }, n); // §13, same as createProject
  const { data, error } = await db().from("confidential_projects").select("name").eq("slug", s).maybeSingle();
  pg(error, "lookup project");
  if (!data) throw new ApiError(404, "NOT_FOUND", "unknown project");
  const from = (data as { name: string }).name;
  const upd = await db().from("confidential_projects").update({ name: n }).eq("slug", s);
  pg(upd.error, "rename project");
  await audit("project_rename", s, { from, to: n });
  return { slug: s, name: n };
}

export async function setGrant(agent: AgentId, deviceId: string, slug: string, granted: boolean): Promise<{ changed: boolean }> {
  const a = vAgent(agent);
  const d = vDevice(deviceId);
  const s = vSlug(slug);
  if (typeof granted !== "boolean") invalid("granted must be a boolean");
  const { data, error } = await db().rpc("hub_set_grant", { p_agent: a, p_device: d, p_slug: s, p_granted: granted });
  pg(error, "set grant");
  return { changed: data === true };
}

export async function listAudit(limit = 50): Promise<unknown[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 50;
  const { data, error } = await db()
    .from("admin_audit")
    .select("id, at, actor, action, target, detail")
    .order("id", { ascending: false })
    .limit(n);
  pg(error, "list audit");
  return (data ?? []) as unknown[];
}

// Roles of every identity matching `agent` (all its devices) or `agent@machine` (defaults applied).
// No matching identity -> [defaultRole(agent)]: any identity created later starts at that role, so callers
// (lead dispatch check) treat an unknown target exactly like a freshly connected one.
export async function roleOfTarget(target: string): Promise<Role[]> {
  const m = typeof target === "string" ? target.match(TARGET_RE) : null;
  if (!m) invalid("target must be <agent> or <agent>@<machine>");
  const agent = m[1] as AgentId;
  const machine = m[2];

  if (machine !== undefined) {
    const dev = await db().from("devices").select("id").eq("machine_name", machine).maybeSingle();
    pg(dev.error, "lookup device");
    if (!dev.data) return [defaultRole(agent)];
    const row = await db()
      .from("agent_roles")
      .select("role")
      .eq("agent", agent)
      .eq("device_id", (dev.data as { id: string }).id)
      .maybeSingle();
    pg(row.error, "lookup role");
    return [(row.data as { role: Role } | null)?.role ?? defaultRole(agent)];
  }

  const [roles, tok] = await Promise.all([
    db().from("agent_roles").select("device_id, role").eq("agent", agent),
    db().from("agent_tokens").select("device_id").eq("agent", agent).is("revoked_at", null).not("device_id", "is", null),
  ]);
  pg(roles.error, "list roles");
  pg(tok.error, "list tokens");
  const byDevice = new Map(((roles.data ?? []) as Array<{ device_id: string; role: Role }>).map((r) => [r.device_id, r.role]));
  for (const t of (tok.data ?? []) as Array<{ device_id: string }>) {
    if (!byDevice.has(t.device_id)) byDevice.set(t.device_id, defaultRole(agent));
  }
  return byDevice.size ? Array.from(byDevice.values()) : [defaultRole(agent)];
}

// Current role of each `agent@machine` identity, resolved fresh (no cache) for read-time decoration of task rows.
// Batched: one devices query + one agent_roles query for ALL idents (no N+1). Unknown / malformed ident, or a
// machine with no device row -> null (never a default role: an unknown identity must not look like anyone's peer).
// A known device without an agent_roles row gets the §11 default for its agent, same as roleOfTarget.
export async function roleOfIdents(idents: string[]): Promise<Map<string, Role | null>> {
  const out = new Map<string, Role | null>();
  const parsed: Array<{ ident: string; agent: AgentId; machine: string }> = [];
  for (const ident of new Set(idents)) {
    const m = typeof ident === "string" ? ident.match(TARGET_RE) : null;
    if (m && m[2] !== undefined) parsed.push({ ident, agent: m[1] as AgentId, machine: m[2] });
    else out.set(ident, null);
  }
  if (!parsed.length) return out;
  const dev = await db().from("devices").select("id, machine_name").in("machine_name", [...new Set(parsed.map((p) => p.machine))]);
  pg(dev.error, "lookup devices");
  const deviceOf = new Map(((dev.data ?? []) as Array<{ id: string; machine_name: string }>).map((d) => [d.machine_name, d.id]));
  const ids = [...new Set(deviceOf.values())];
  const stored = new Map<string, Role>();
  if (ids.length) {
    const rows = await db().from("agent_roles").select("agent, device_id, role").in("device_id", ids);
    pg(rows.error, "lookup roles");
    for (const r of (rows.data ?? []) as Array<{ agent: string; device_id: string; role: Role }>) stored.set(`${r.agent}|${r.device_id}`, r.role);
  }
  for (const p of parsed) {
    const deviceId = deviceOf.get(p.machine);
    out.set(p.ident, deviceId ? (stored.get(`${p.agent}|${deviceId}`) ?? defaultRole(p.agent)) : null);
  }
  return out;
}
