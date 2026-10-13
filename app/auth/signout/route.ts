import { NextResponse } from "next/server";
import { authClient } from "../../../lib/dash/supabase";
import { noStore } from "../finish";

export const dynamic = "force-dynamic";

// POST only (a GET link could be triggered cross-site). Cross-origin posts are refused.
export async function POST(req: Request): Promise<NextResponse> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    if (originHost !== host) return noStore(NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 }));
  }
  try {
    const sb = await authClient();
    await sb.auth.signOut();
  } catch {
    // session already gone or Auth unreachable: cookies are cleared below either way
  }
  return noStore(NextResponse.redirect(new URL("/login?e=signedout", req.url), 303));
}
