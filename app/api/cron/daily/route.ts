import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../../../../lib/db";
import { backfill } from "../../../../lib/handlers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest();

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const got = req.headers.get("authorization") ?? "";
  return timingSafeEqual(sha(got), sha(`Bearer ${secret}`));
}

const fail = (code: string, status: number) =>
  Response.json({ error: { code, message: code.toLowerCase() } }, { status });

// Vercel Cron (daily 20:00 UTC, vercel.json): keep-alive + retention pruning + re-embed up to 16 rows missing an embedding.
export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) return fail("UNAUTHORIZED", 401);
  const sb = db();
  try {
    const keep = await sb.from("system_flags").select("key").limit(1);
    if (keep.error) throw keep.error;

    const steps = {
      access_log: sb.from("access_log").delete({ count: "exact" }).lt("at", ago(90)),
      connect_codes: sb.from("connect_codes").delete({ count: "exact" }).lt("expires_at", ago(1)),
      rate_limits: sb.from("rate_limits").delete({ count: "exact" }).lt("window_start", ago(1)),
      approvals_expired: sb
        .from("approvals")
        .update({ status: "expired" }, { count: "exact" })
        .eq("status", "pending")
        .lt("created_at", ago(7)),
    };
    const pruned: Record<string, number> = {};
    for (const [name, q] of Object.entries(steps)) {
      const { count, error } = await q;
      if (error) {
        console.error("cron/daily", name, error.code);
        return fail("CRON_FAILED", 500);
      }
      pruned[name] = count ?? 0;
    }
    // Embedding is best-effort: a failed embed never fails the cron (rows stay null for tomorrow).
    let reembed: Awaited<ReturnType<typeof backfill>> | { error: string };
    try {
      reembed = await backfill({ limit: 16 });
    } catch (e) {
      console.error("cron/daily", "reembed", (e as { code?: string })?.code ?? "unknown");
      reembed = { error: "REEMBED_FAILED" };
    }
    return Response.json({ data: { ok: true, pruned, reembed } });
  } catch (e) {
    console.error("cron/daily", (e as { code?: string })?.code ?? "unknown");
    return fail("CRON_FAILED", 500);
  }
}
