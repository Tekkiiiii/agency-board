import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdminEmail, safeNext } from "../../lib/dash/supabase";

// Shared tail of /auth/callback and /auth/confirm: re-check the allowlist on the fresh session,
// then redirect to a same-origin dashboard path.
export async function finishSignIn(sb: SupabaseClient, req: Request, next: string | null): Promise<NextResponse> {
  const { data, error } = await sb.auth.getUser();
  if (error || !isAdminEmail(data.user?.email)) {
    await sb.auth.signOut().catch((e) => console.error("[hub] SIGNOUT_FAILED", String((e as { code?: string })?.code ?? (e as Error)?.name ?? "unknown")));
    return toLogin(req, "denied");
  }
  return noStore(NextResponse.redirect(new URL(safeNext(next), req.url), 303));
}

export function toLogin(req: Request, e: string): NextResponse {
  return noStore(NextResponse.redirect(new URL(`/login?e=${encodeURIComponent(e)}`, req.url), 303));
}

export function noStore(res: NextResponse): NextResponse {
  res.headers.set("cache-control", "no-store");
  res.headers.set("referrer-policy", "same-origin");
  return res;
}
