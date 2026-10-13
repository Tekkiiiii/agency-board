import { after } from "next/server";
import { logAndEvaluate } from "../../../../lib/access";
import { db } from "../../../../lib/db";
import { exchangeCode } from "../../../../lib/devices";
import { errorResponse, getMeta, json } from "../../../../lib/request";
import { ApiError } from "../../../../lib/types";

export const dynamic = "force-dynamic";

const ROUTE = "connect:exchange";
const FAIL_WINDOW_S = 600;
const FAIL_MAX = 5;

// Same window_start as hub_rate_hit: date_bin(window, now(), epoch).
function windowStart(): string {
  const w = FAIL_WINDOW_S * 1000;
  return new Date(Math.floor(Date.now() / w) * w).toISOString();
}

// Peek without incrementing: hub_rate_hit always counts, and only failures may count.
async function failuresInWindow(key: string): Promise<number> {
  const { data, error } = await db()
    .from("rate_limits")
    .select("count")
    .eq("key", key)
    .eq("window_start", windowStart())
    .maybeSingle();
  if (error) throw new Error(`rate peek failed: ${error.message}`);
  return (data as { count: number } | null)?.count ?? 0;
}

export async function POST(req: Request): Promise<Response> {
  const meta = getMeta(req);
  const key = `connect-fail:${meta.ip ?? "unknown"}`;
  const base = (process.env.AGENCY_BOARD_BASE_URL || new URL(req.url).origin).replace(/\/+$/, "");
  let res: Response;
  try {
    if ((await failuresInWindow(key)) >= FAIL_MAX) {
      const retry = FAIL_WINDOW_S - Math.floor((Date.now() / 1000) % FAIL_WINDOW_S);
      throw new ApiError(429, "RATE_LIMITED", "Too many failed connect attempts", { retry_after: retry });
    }
    let body: { code?: unknown; hostname?: unknown; os?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      throw new ApiError(422, "VALIDATION", "Body must be JSON {code, hostname?, os?}");
    }
    if (!body || typeof body.code !== "string") throw new ApiError(422, "VALIDATION", "code is required");
    try {
      const r = await exchangeCode(
        {
          code: body.code,
          hostname: typeof body.hostname === "string" ? body.hostname.slice(0, 100) : undefined,
          os: typeof body.os === "string" ? body.os : undefined,
        },
        meta,
      );
      const flat: Record<string, string> = {};
      for (const [agent, raw] of Object.entries(r.tokens)) if (raw) flat[`token_${agent}`] = raw;
      res = json({
        machine: r.machine,
        device_id: r.deviceId,
        server_url: `${base}/api/mcp`,
        rest_url: `${base}/api/v1`,
        tokens: r.tokens,
        ...flat,
      });
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) {
        await db().rpc("hub_rate_hit", { p_key: key, p_window_seconds: FAIL_WINDOW_S, p_max: FAIL_MAX });
      }
      throw e;
    }
  } catch (e) {
    res = errorResponse(e);
  }
  res.headers.set("cache-control", "no-store");
  const status = res.status;
  try {
    after(() => logAndEvaluate(meta, null, ROUTE, status).catch((e) => console.error("[hub] ACCESS_LOG_FAILED", String((e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown"))));
  } catch {
    void logAndEvaluate(meta, null, ROUTE, status).catch((e) => console.error("[hub] ACCESS_LOG_FAILED", String((e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown")));
  }
  return res;
}
