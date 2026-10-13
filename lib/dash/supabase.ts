import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";

// Supabase Auth clients for the overseer dashboard (§16). The anon key is used ONLY for Auth calls;
// table access always goes through the service-role client in lib/db.ts.

function authEnv(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("lib/dash/supabase: SUPABASE_URL and SUPABASE_ANON_KEY must be set");
  return { url, key };
}

// The single allowlisted admin email (lowercased), or null when unset (then nobody is allowed).
export function adminEmail(): string | null {
  const e = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  return e ? e : null;
}

export function isAdminEmail(email: string | null | undefined): boolean {
  const allowed = adminEmail();
  return !!allowed && !!email && email.trim().toLowerCase() === allowed;
}

// Only same-origin relative paths inside the dashboard are honoured as `next` targets.
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  if (next !== "/dashboard" && !next.startsWith("/dashboard/") && !next.startsWith("/dashboard?")) return fallback;
  return next;
}

// Server components, server actions and route handlers. Server components cannot write cookies;
// the middleware refreshes the session, so setAll failures there are safe to ignore.
export async function authClient(): Promise<SupabaseClient> {
  const { url, key } = authEnv();
  const store = await cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(list) {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // called from a server component: read-only cookies, middleware handles refresh
        }
      },
    },
  });
}

// Middleware variant. Refreshed cookies are written to the request (so downstream server
// components see the new session and do not replay the used refresh token) and to the response.
// `response()` returns the pass-through response carrying those cookies; it is rebuilt on every
// cookie write, so always read it AFTER calling auth.getUser().
export function middlewareClient(req: NextRequest): { supabase: SupabaseClient; response: () => NextResponse } {
  const { url, key } = authEnv();
  let res = NextResponse.next({ request: req });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll(list, headers) {
        for (const { name, value } of list) req.cookies.set(name, value);
        res = NextResponse.next({ request: req });
        for (const { name, value, options } of list) res.cookies.set(name, value, options);
        for (const [k, v] of Object.entries(headers ?? {})) res.headers.set(k, v);
      },
    },
  });
  return { supabase, response: () => res };
}
