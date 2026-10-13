import { db } from "../../../lib/db";

export const dynamic = "force-dynamic";

// Public. Never leaks error detail.
export async function GET(): Promise<Response> {
  let ok = false;
  try {
    const { error } = await db().from("system_flags").select("key").limit(1);
    ok = !error;
  } catch {
    ok = false;
  }
  return Response.json({ ok: true, db: ok, time: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
}
