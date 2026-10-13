import { headers } from "next/headers";
import { logAndEvaluate } from "../access";
import { getMeta } from "../request";

// Audit trail for dashboard server actions (§16): access_log route = 'dash:<name>'.
// Page GETs and polls are not logged. Never throws: logging must not affect the action.
export async function logAdminAction(name: string, status: number): Promise<void> {
  try {
    const h = await headers();
    const meta = getMeta(new Request("http://dashboard.invalid/", { headers: new Headers(h) }));
    await logAndEvaluate(meta, null, `dash:${name}`, status);
  } catch (e) {
    console.error("[hub] dash log failed", String((e as { code?: unknown })?.code ?? (e as Error)?.name ?? "unknown"));
  }
}
