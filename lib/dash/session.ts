import { redirect } from "next/navigation";
import { authClient, isAdminEmail } from "./supabase";

// First call in every dashboard page, server action and dashboard route handler (§16).
// getUser() validates the JWT against the Auth server; getSession() alone is never trusted.
export async function requireAdmin(): Promise<{ email: string }> {
  let email: string | null = null;
  try {
    const sb = await authClient();
    const { data, error } = await sb.auth.getUser();
    if (!error) email = data.user?.email?.toLowerCase() ?? null;
  } catch {
    email = null;
  }
  if (!email || !isAdminEmail(email)) redirect("/login");
  return { email };
}
