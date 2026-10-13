import { db } from "./db";
import type { Flags } from "./types";

export async function getFlags(): Promise<Flags> {
  const { data, error } = await db().from("system_flags").select("key, value");
  if (error) throw error;
  const m = new Map((data ?? []).map((r) => [r.key as string, !!r.value]));
  return { dispatchPaused: m.get("dispatch_paused") ?? false, writesFrozen: m.get("writes_frozen") ?? false };
}

export async function setFlags(p: Partial<Flags>): Promise<Flags> {
  const set_at = new Date().toISOString();
  const rows: Array<{ key: string; value: boolean; set_at: string }> = [];
  if (p.dispatchPaused !== undefined) rows.push({ key: "dispatch_paused", value: p.dispatchPaused, set_at });
  if (p.writesFrozen !== undefined) rows.push({ key: "writes_frozen", value: p.writesFrozen, set_at });
  if (rows.length) {
    const { error } = await db().from("system_flags").upsert(rows, { onConflict: "key" });
    if (error) throw error;
  }
  return getFlags();
}
