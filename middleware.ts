import { NextResponse, type NextRequest } from "next/server";
import { isAdminEmail, middlewareClient } from "./lib/dash/supabase";

// Dashboard gate (§16). Not the only gate: every page/action also calls requireAdmin().

const SECURITY_HEADERS: Record<string, string> = {
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
};

function harden<T extends NextResponse>(res: T): T {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
  return res;
}

// Redirect while keeping any refreshed/cleared auth cookies from the pass-through response.
function redirectWith(req: NextRequest, from: NextResponse, path: string, params?: Record<string, string>): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  for (const c of from.cookies.getAll()) res.cookies.set(c);
  return harden(res);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  const isDashboard = path === "/dashboard" || path.startsWith("/dashboard/");

  // Bearer tokens (agent agency-board_* or admin agency-board-admin_*) never authenticate the dashboard.
  if (isDashboard && /^\s*bearer\s/i.test(req.headers.get("authorization") ?? "")) {
    return harden(NextResponse.json({ error: { code: "ADMIN_ONLY", message: "Bearer tokens are not accepted on the dashboard" } }, { status: 403 }));
  }

  let email: string | null = null;
  let response: NextResponse;
  try {
    const mw = middlewareClient(req);
    const { data } = await mw.supabase.auth.getUser(); // validates with the Auth server + refreshes
    email = data.user?.email ?? null;
    response = mw.response();
  } catch {
    // misconfigured env or Auth unreachable: fail closed
    response = NextResponse.next({ request: req });
  }
  const allowed = isAdminEmail(email);

  if (isDashboard && !allowed) {
    const next = path + req.nextUrl.search;
    return redirectWith(req, response, "/login", next === "/dashboard" ? undefined : { next });
  }
  if (path === "/login" && allowed) return redirectWith(req, response, "/dashboard");

  return harden(response);
}

export const config = {
  matcher: ["/dashboard/:path*", "/login"],
};
