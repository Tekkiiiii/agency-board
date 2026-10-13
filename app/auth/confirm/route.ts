import type { EmailOtpType } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { authClient } from "../../../lib/dash/supabase";
import { finishSignIn, toLogin } from "../finish";

export const dynamic = "force-dynamic";

const TYPES: readonly EmailOtpType[] = ["email", "magiclink", "signup", "invite", "recovery", "email_change"];

// Token-hash email template landing: ?token_hash=...&type=magiclink&next=/dashboard/...
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") as EmailOtpType | null;
  if (!tokenHash || tokenHash.length > 512 || !type || !TYPES.includes(type)) return toLogin(req, "link");
  try {
    const sb = await authClient();
    const { error } = await sb.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) return toLogin(req, "link");
    return await finishSignIn(sb, req, url.searchParams.get("next"));
  } catch {
    return toLogin(req, "link");
  }
}
