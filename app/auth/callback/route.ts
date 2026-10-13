import type { NextResponse } from "next/server";
import { authClient } from "../../../lib/dash/supabase";
import { finishSignIn, toLogin } from "../finish";

export const dynamic = "force-dynamic";

// PKCE magic-link landing: ?code=...&next=/dashboard/...
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  if (!code || code.length > 512) return toLogin(req, "link");
  try {
    const sb = await authClient();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) return toLogin(req, "link");
    return await finishSignIn(sb, req, url.searchParams.get("next"));
  } catch {
    return toLogin(req, "link");
  }
}
