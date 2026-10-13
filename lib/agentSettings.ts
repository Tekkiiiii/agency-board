// Listen/wait check interval, per agent@machine (table agent_settings, migration 20261013000007). Minutes 0..60, 0 = off.
// Readers NEVER throw: a missing table (migration not applied yet), any DB error or no row means the default 30,
// so a poll can never fail because of this setting.
import { db } from "./db";
import { ApiError, type AgentId } from "./types";

export const LISTEN_MIN = 0;
export const LISTEN_MAX = 60;
export const LISTEN_DEFAULT = 30;

/** Integer 0..60 given as a number or a string of digits; anything else is null. */
export function parseListenMinutes(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= LISTEN_MIN && n <= LISTEN_MAX ? n : null;
}

export async function getListenMinutes(agent: AgentId, deviceId: string | null): Promise<number> {
  if (!deviceId) return LISTEN_DEFAULT;
  try {
    const { data, error } = await db().from("agent_settings").select("listen_minutes").eq("agent", agent).eq("device_id", deviceId).maybeSingle();
    if (error) return LISTEN_DEFAULT;
    return parseListenMinutes(data?.listen_minutes) ?? LISTEN_DEFAULT;
  } catch {
    return LISTEN_DEFAULT;
  }
}

export async function setListenMinutes(agent: AgentId, deviceId: string, minutes: unknown): Promise<number> {
  const m = parseListenMinutes(minutes);
  if (m === null) throw new ApiError(422, "VALIDATION", `listen_minutes must be an integer ${LISTEN_MIN}-${LISTEN_MAX}`);
  if (!["claude", "codex", "hermes", "grok"].includes(agent)) throw new ApiError(422, "VALIDATION", "unknown agent");
  const { error } = await db().from("agent_settings")
    .upsert({ agent, device_id: deviceId, listen_minutes: m, updated_at: new Date().toISOString() }, { onConflict: "agent,device_id" });
  if (error) throw new Error(`agent_settings upsert failed: ${error.code ?? error.message}`);
  return m;
}

/** Existing rows only, keyed `${agent}:${deviceId}`. */
export async function listListenMinutes(deviceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!deviceIds.length) return out;
  try {
    const { data, error } = await db().from("agent_settings").select("agent, device_id, listen_minutes").in("device_id", deviceIds);
    if (error) return out;
    for (const r of data ?? []) {
      const m = parseListenMinutes(r.listen_minutes);
      if (m !== null) out.set(`${r.agent}:${r.device_id}`, m);
    }
  } catch { /* default applies */ }
  return out;
}
