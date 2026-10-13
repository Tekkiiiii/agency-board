import { db } from "../db";

export interface NavCounts {
  approvals: number;
  inbox: number;
  alerts: number;
}

// "Needs you" counts for the nav badges: pending approvals, pending inbox memories (restricted agents),
// open HIGH (red) alerts, read or not. The alerts count is the same set the overview "Needs you"
// card and the Devices Alerts card badge count, so all three numbers always agree. head:true = count only, no rows transferred. A failed count renders as 0
// (logged) so the shell never breaks; the owning page shows the real error.
export async function navCounts(): Promise<NavCounts> {
  const s = db();
  const [approvals, inbox, alerts] = await Promise.all([
    s.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    s
      .from("memories")
      .select("id", { count: "exact", head: true })
      .eq("namespace", "shared/inbox")
      .eq("review_status", "pending")
      .is("deleted_at", null),
    s.from("alerts").select("id", { count: "exact", head: true }).eq("status", "open").eq("severity", "red"),
  ]);
  const pick = (name: string, r: { count: number | null; error: { code?: string } | null }): number => {
    if (r.error) {
      console.error("[hub] navCounts failed", name, String(r.error.code ?? "unknown"));
      return 0;
    }
    return r.count ?? 0;
  };
  return { approvals: pick("approvals", approvals), inbox: pick("inbox", inbox), alerts: pick("alerts", alerts) };
}
