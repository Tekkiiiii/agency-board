import { dismissAlert, listAlerts, trustAlert } from "../../../../lib/access";
import { issueConnectCode, listDevices, revokeAgent, revokeDevice, rotateDevice } from "../../../../lib/devices";
import { getFlags, setFlags } from "../../../../lib/flags";
import * as H from "../../../../lib/handlers";
import { errorResponse, json, withAdmin } from "../../../../lib/request";
import { createProject, listAudit, listIdentities, listProjects, renameProject, setGrant, setRole } from "../../../../lib/roles";
import * as S from "../../../../lib/schemas";
import { ApiError } from "../../../../lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type In = { body: Record<string, unknown>; p: Record<string, string>; url: URL; base: string };
type Op = (i: In) => Promise<unknown>;

const uuid = (id: string) => S.idSchema.parse({ id }).id;

const ROUTES: Array<[string, string, string, Op]> = [
  ["POST", "connect-codes", "connect_code", async ({ body, base }) => {
    const p = S.connectCodeSchema.parse(body);
    return issueConnectCode({ machineName: p.machine_name, agents: p.agents, os: p.os }, base);
  }],
  ["GET", "devices", "devices", () => listDevices()],
  ["POST", "devices/:id/rotate", "device_rotate", ({ p, base }) => rotateDevice(uuid(p.id), base)],
  ["POST", "devices/:id/revoke", "device_revoke", async ({ p }) => (await revokeDevice(uuid(p.id)), { id: p.id, revoked: true })],
  ["POST", "agents/:agent/revoke", "agent_revoke", async ({ p }) => {
    const { agent } = S.agentParamSchema.parse(p);
    return { agent, revoked: await revokeAgent(agent) };
  }],
  ["GET", "flags", "flags_get", () => getFlags()],
  ["POST", "flags", "flags_set", async ({ body }) => {
    const f = S.flagsSchema.parse(body);
    return setFlags({ dispatchPaused: f.dispatch_paused, writesFrozen: f.writes_frozen });
  }],
  ["GET", "alerts", "alerts", ({ url }) => listAlerts(url.searchParams.get("status") ?? undefined)],
  ["POST", "alerts/:id/trust", "alert_trust", async ({ p }) => (await trustAlert(uuid(p.id)), { id: p.id, status: "trusted" })],
  ["POST", "alerts/:id/dismiss", "alert_dismiss", async ({ p }) => (await dismissAlert(uuid(p.id)), { id: p.id, status: "dismissed" })],
  ["GET", "inbox", "inbox", () => H.inboxList()],
  ["POST", "inbox/:id/approve", "inbox_approve", ({ body, p }) => H.inboxApprove({ ...body, id: p.id })],
  ["POST", "inbox/:id/reject", "inbox_reject", ({ p }) => H.inboxReject({ id: p.id })],
  ["GET", "approvals", "approvals", ({ url }) => H.approvalsList(url.searchParams.get("status") ?? "pending")],
  ["POST", "approvals/:id", "approval_decide", ({ body, p }) => H.approvalDecide({ ...body, id: p.id })],
  ["POST", "backfill", "backfill", ({ body }) => H.backfill(body)],
  // MVP-b0 (§15): identities, roles, confidential projects, grants, audit.
  ["GET", "identities", "identities", () => listIdentities()],
  ["POST", "roles", "role_set", async ({ body }) => {
    const r = S.setRoleSchema.parse(body);
    return setRole(r.agent, r.device_id, r.role);
  }],
  ["GET", "confidential", "projects", () => listProjects()],
  ["POST", "confidential", "project_create", async ({ body }) => {
    const c = S.createProjectSchema.parse(body);
    return createProject(c.slug, c.name);
  }],
  ["PATCH", "confidential/:slug", "project_rename", async ({ body, p }) => {
    const c = S.renameProjectSchema.parse({ ...body, slug: p.slug });
    return renameProject(c.slug, c.name);
  }],
  ["POST", "grants", "grant_set", async ({ body }) => {
    const g = S.setGrantSchema.parse(body);
    return setGrant(g.agent, g.device_id, g.project, g.granted);
  }],
  ["GET", "audit", "audit", async ({ url }) => {
    const raw = url.searchParams.get("limit");
    return listAudit(S.auditSchema.parse({ limit: raw === null || raw === "" ? undefined : raw }).limit);
  }],
];

function match(pattern: string, parts: string[]): Record<string, string> | null {
  const segs = pattern.split("/");
  if (segs.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].startsWith(":")) params[segs[i].slice(1)] = parts[i];
    else if (segs[i] !== parts[i]) return null;
  }
  return params;
}

async function bodyInput(req: Request): Promise<Record<string, unknown>> {
  if (req.method === "GET") return {};
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new ApiError(422, "VALIDATION", "Body must be a JSON object");
}

async function handle(req: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  for (const [method, pattern, name, op] of ROUTES) {
    if (method !== req.method) continue;
    const p = match(pattern, path);
    if (!p) continue;
    return withAdmin(req, `admin:${name}`, async () => {
      const url = new URL(req.url);
      const base = (process.env.AGENCY_BOARD_BASE_URL || url.origin).replace(/\/+$/, "");
      return json(await op({ body: await bodyInput(req), p, url, base }));
    });
  }
  return errorResponse(new ApiError(404, "NOT_FOUND", "No such route"));
}

export { handle as GET, handle as POST, handle as PATCH };
