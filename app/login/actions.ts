"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "../../lib/db";
import { getMeta } from "../../lib/request";
import { authClient, isAdminEmail, safeNext } from "../../lib/dash/supabase";

const emailSchema = z.email().max(254);

async function baseUrl(h: Headers): Promise<string> {
  const env = process.env.AGENCY_BOARD_BASE_URL?.trim().replace(/\/+$/, "");
  if (env) return env;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:13100";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

// Magic-link request (§16). Same outcome for allowed and non-allowed addresses (no account oracle);
// non-allowed addresses never reach Supabase Auth. 5 attempts / 10 min / IP.
export async function requestLink(formData: FormData): Promise<void> {
  const h = new Headers(await headers());
  const meta = getMeta(new Request("http://login.invalid/", { headers: h }));
  const next = safeNext(String(formData.get("next") ?? ""));
  const keepNext = next === "/dashboard" ? "" : `&next=${encodeURIComponent(next)}`;

  const { data: ok, error: rlErr } = await db().rpc("hub_rate_hit", {
    p_key: `login:${meta.ip ?? "unknown"}`,
    p_window_seconds: 600,
    p_max: 5,
  });
  if (rlErr) {
    console.error("[hub] login rate-limit failed", String(rlErr.code ?? "unknown"));
    redirect(`/login?e=error${keepNext}`);
  }
  if (ok !== true) redirect(`/login?e=rate${keepNext}`);

  const parsed = emailSchema.safeParse(String(formData.get("email") ?? "").trim().toLowerCase());
  if (!parsed.success) redirect(`/login?e=invalid${keepNext}`);
  const email = parsed.data;

  if (isAdminEmail(email)) {
    try {
      const sb = await authClient();
      const redirectTo = `${await baseUrl(h)}/auth/callback${next === "/dashboard" ? "" : `?next=${encodeURIComponent(next)}`}`;
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirectTo } });
      if (error) console.error("[hub] login otp failed", String(error.code ?? error.status ?? "unknown"));
    } catch (e) {
      console.error("[hub] login otp threw", String((e as Error)?.name ?? "unknown"));
    }
  }
  redirect(`/login?sent=1${keepNext}`);
}
