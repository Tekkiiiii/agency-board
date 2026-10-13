import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { after } from "next/server";
import { ZodError } from "zod";
import { logAndEvaluate, networkKey } from "./access";
import { authenticateTokenDetailed, isAdminToken } from "./auth";
import { db } from "./db";
import { getFlags } from "./flags";
import { TIER_MESSAGES, tierHit } from "./guard";
import { ApiError, type AdminCtx, type AgentCtx, type RequestMeta } from "./types";

const als = new AsyncLocalStorage<AgentCtx>();

function clientFamily(ua: string | null): string | null {
  if (!ua) return null;
  const l = ua.toLowerCase();
  if (l.includes("claude")) return "claude-code"; // covers 'claude-code'
  if (l.includes("codex")) return "codex";
  if (l.includes("hermes")) return "hermes";
  if (l.includes("grok") || l.includes("cursor")) return "grok-bot";
  if (l.includes("curl")) return "curl";
  if (l.includes("powershell")) return "powershell";
  return ua.trim().split(/[\s/]/)[0].slice(0, 40) || null;
}

export function getMeta(req: Request): RequestMeta {
  const h = req.headers;
  const first = h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const ip = first && isIP(first.split("%")[0]) ? first : null;
  const cc = h.get("x-vercel-ip-country")?.trim().toUpperCase() ?? "";
  const country = /^[A-Z]{2}$/.test(cc) ? cc : null;
  let city: string | null = null;
  const rawCity = h.get("x-vercel-ip-city");
  if (rawCity) {
    try { city = decodeURIComponent(rawCity).slice(0, 100); } catch { city = null; }
  }
  const asnN = parseInt(h.get("x-vercel-ip-as-number") ?? "", 10);
  const asn = Number.isFinite(asnN) ? asnN : null;
  return { ip, country, city, asn, network: networkKey(ip, asn), client: clientFamily(h.get("user-agent")), at: new Date() };
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : null;
}

function schedule(task: () => Promise<void>): void {
  try {
    after(() => task().catch((e) => console.error("[hub] ACCESS_LOG_FAILED", String((e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown"))));
  } catch {
    void task().catch((e) => console.error("[hub] AFTER_TASK_FAILED", String((e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown"))); // outside a Next request scope (tests, scripts)
  }
}

export async function withAgent(req: Request, route: string, fn: (ctx: AgentCtx) => Promise<Response>): Promise<Response> {
  const meta = getMeta(req);
  let ctx: AgentCtx | null = null;
  let status = 500;
  try {
    const raw = bearer(req);
    if (raw?.startsWith("agency-board-admin_")) throw new ApiError(403, "AGENT_ONLY", "Admin token not accepted on agent routes");
    if (!raw) throw new ApiError(401, "UNAUTHORIZED", "Missing bearer token");
    const r = await authenticateTokenDetailed(raw);
    if ("error" in r) throw new ApiError(401, r.error, r.error === "REVOKED" ? "Token revoked" : "Invalid token");
    const c: AgentCtx = { ...r.ctx, flags: await getFlags(), route };
    ctx = c;
    const res = await als.run(c, () => fn(c));
    status = res.status;
    return res;
  } catch (e) {
    const res = errorResponse(e);
    status = res.status;
    return res;
  } finally {
    const c = ctx;
    schedule(() => logAndEvaluate(meta, c, c?.route ?? route, status));
  }
}

export async function withAdmin(req: Request, route: string, fn: (ctx: AdminCtx) => Promise<Response>): Promise<Response> {
  const meta = getMeta(req);
  const r = route.startsWith("admin:") ? route : `admin:${route}`;
  let status = 500;
  try {
    const raw = bearer(req);
    if (raw?.startsWith("agency-board_")) throw new ApiError(403, "ADMIN_ONLY", "Agent token not accepted on admin routes");
    if (!raw || !isAdminToken(raw)) throw new ApiError(401, "UNAUTHORIZED", "Invalid admin token");
    const res = await fn({ kind: "admin", route: r });
    status = res.status;
    return res;
  } catch (e) {
    const res = errorResponse(e);
    status = res.status;
    return res;
  } finally {
    schedule(() => logAndEvaluate(meta, null, r, status));
  }
}

export function currentCtx(): AgentCtx {
  const c = als.getStore();
  if (!c) throw new Error("currentCtx() called outside withAgent");
  return c;
}

export function setRoute(route: string): void {
  const c = als.getStore();
  if (c) c.route = route;
}

const LIMITS: Record<"read" | "write" | "heartbeat" | "dispatch", number> = { read: 120, write: 60, heartbeat: 2, dispatch: 120 };
const WINDOW = 60;

export async function enforce(ctx: AgentCtx, kind: "read" | "write" | "heartbeat" | "dispatch"): Promise<void> {
  if (kind === "write" && ctx.flags.writesFrozen) throw new ApiError(423, "WRITES_FROZEN", "Writes are frozen");
  if (kind === "dispatch" && ctx.flags.dispatchPaused) throw new ApiError(423, "DISPATCH_PAUSED", "Dispatch is paused");
  const { data, error } = await db().rpc("hub_rate_hit", { p_key: `rl:${ctx.tokenId}:${kind}`, p_window_seconds: WINDOW, p_max: LIMITS[kind] });
  if (error) throw error;
  if (data !== true) {
    const retry_after = WINDOW - (Math.floor(Date.now() / 1000) % WINDOW);
    throw new ApiError(429, "RATE_LIMITED", "Rate limit exceeded", { retry_after });
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json({ data }, { status });
}

function errBody(status: number, code: string, message: string, details?: unknown, headers?: HeadersInit): Response {
  const error: Record<string, unknown> = { code, message };
  if (details !== undefined) error.details = details;
  return Response.json({ error }, { status, headers });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) {
    const ra = (e.details as { retry_after?: number } | undefined)?.retry_after;
    return errBody(e.status, e.code, e.message, e.details, e.code === "RATE_LIMITED" && ra ? { "retry-after": String(ra) } : undefined);
  }
  if (e instanceof ZodError || (e as { name?: string })?.name === "ZodError") {
    const issues = (e as ZodError).issues.map((i) => ({ path: i.path.map(String), message: i.message, code: i.code }));
    return errBody(422, "VALIDATION", "Invalid input", { issues });
  }
  // DB trigger raises (§13.3 / §13.5): `<CODE>:<rule>` for CREDENTIALS_BLOCKED, CUSTOMER_PII_BLOCKED,
  // EMPLOYEE_PII_BLOCKED, FINANCIALS_BLOCKED, CONFIDENTIAL. Fixed message + {rule}; never echo content.
  const tier = tierHit(e);
  if (tier) return errBody(422, tier.code, TIER_MESSAGES[tier.code], { rule: tier.rule ?? "unknown" });
  const code = (e as { code?: unknown })?.code ?? (e as Error)?.name ?? "unknown";
  console.error("[hub] internal error", String(code));
  return errBody(500, "INTERNAL", "Internal error");
}
