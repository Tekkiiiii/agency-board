import { isIP } from "node:net";
import { db } from "./db";
import { ApiError, type AgentCtx, type RequestMeta } from "./types";

export interface KnownSet { countries: Set<string>; networks: Set<string> }
export interface RecentHit { at: Date; network: string | null; country: string | null }
export interface AlertDraft {
  rule: "new_country" | "concurrent_use" | "new_network" | "auth_burst";
  severity: "red" | "yellow";
  value: string;
  detail: Record<string, unknown>;
}

// Network key: asn:<n> when ASN known, else IPv4 /24 or IPv6 /48. Shared by getMeta and stored-row replay.
export function networkKey(ip: string | null, asn: number | null): string | null {
  if (asn != null && Number.isFinite(asn)) return `asn:${asn}`;
  if (!ip) return null;
  let a = ip.split("%")[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(a);
  if (mapped) a = mapped[1];
  const v = isIP(a);
  if (v === 4) {
    const p = a.split(".");
    return `net:${p[0]}.${p[1]}.${p[2]}.0/24`;
  }
  if (v === 6) {
    const [h, t] = a.split("::");
    const head = h ? h.split(":") : [];
    const tail = a.includes("::") && t ? t.split(":") : [];
    const full = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill("0"), ...tail];
    return `net:${full.slice(0, 3).map((x) => parseInt(x, 16).toString(16)).join(":")}::/48`;
  }
  return null;
}

export function evaluateAlerts(
  cur: { at: Date; network: string | null; country: string | null },
  known: KnownSet,
  recent: RecentHit[],
): AlertDraft[] {
  const out: AlertDraft[] = [];
  const newCountry = !!cur.country && !known.countries.has(cur.country);
  if (newCountry) {
    out.push({ rule: "new_country", severity: "red", value: cur.country!, detail: { network: cur.network } });
  } else if (cur.network && !known.networks.has(cur.network)) {
    out.push({ rule: "new_network", severity: "yellow", value: cur.network, detail: { country: cur.country } });
  }
  // Collapse consecutive repeats; any network seen twice afterwards means it came back after another (A,B,A).
  const seq: string[] = [];
  for (const n of [...recent.map((r) => r.network), cur.network]) {
    if (n && seq[seq.length - 1] !== n) seq.push(n);
  }
  if (new Set(seq).size < seq.length) {
    const nets = [...new Set(seq)].sort();
    out.push({ rule: "concurrent_use", severity: "red", value: nets.join(","), detail: { sequence: seq } });
  }
  return out;
}

export function evaluateAuthBurst(globalFailures5m: number, ipFailures5m: number, ip: string | null): AlertDraft | null {
  if (ip && ipFailures5m >= 5) {
    return { rule: "auth_burst", severity: "red", value: ip, detail: { ipFailures5m, globalFailures5m } };
  }
  if (globalFailures5m >= 10) {
    return { rule: "auth_burst", severity: "red", value: "global", detail: { ipFailures5m, globalFailures5m } };
  }
  return null;
}

async function insertAlert(d: AlertDraft, tokenId: string | null, deviceId: string | null): Promise<void> {
  const { error } = await db()
    .from("alerts")
    .insert({ token_id: tokenId, device_id: deviceId, rule: d.rule, severity: d.severity, value: d.value, detail: d.detail });
  // 23505 = an identical alert is already open (partial unique index) -> "on conflict do nothing".
  if (error && error.code !== "23505") throw error;
}

function logErr(where: string, e: unknown): void {
  const code = (e as { code?: unknown })?.code ?? (e as Error)?.name ?? "unknown";
  console.error(`[hub] access ${where} failed`, String(code));
}

/** Identity recorded on a row without being a token use (connect exchange: ids only, never the token value). */
export interface IssuedRef { tokenId: string; deviceId: string; agent: string }

/** access_log.route of the connect exchange; its rows are the connect event, not token use (excluded from concurrent_use). */
export const EXCHANGE_ROUTE = "connect:exchange";

export async function logAndEvaluate(
  meta: RequestMeta,
  ctx: AgentCtx | null,
  route: string,
  status: number,
  issued?: IssuedRef,
): Promise<void> {
  try {
    const { data: row, error } = await db()
      .from("access_log")
      .insert({
        at: meta.at.toISOString(),
        token_id: ctx?.tokenId ?? issued?.tokenId ?? null,
        device_id: ctx?.deviceId ?? issued?.deviceId ?? null,
        agent: ctx?.agent ?? issued?.agent ?? null,
        ip: meta.ip,
        asn: meta.asn,
        country: meta.country,
        city: meta.city,
        client: meta.client,
        route,
        result: status,
      })
      .select("id")
      .single();
    if (error) throw error;

    if (ctx) {
      const ts = meta.at.toISOString();
      const s = db();
      await Promise.all([
        s.from("agent_tokens").update({ last_used_at: ts }).eq("id", ctx.tokenId),
        ctx.deviceId ? s.from("devices").update({ last_seen_at: ts }).eq("id", ctx.deviceId) : null,
      ]);
      // ponytail: tokens without a device have nothing to trust against; skip alerting for them.
      if (!ctx.deviceId) return;
      const since = new Date(meta.at.getTime() - 10 * 60_000).toISOString();
      const [knownRes, recentRes] = await Promise.all([
        s.from("device_known").select("kind, value").eq("device_id", ctx.deviceId),
        s
          .from("access_log")
          .select("at, ip, asn, country")
          .eq("token_id", ctx.tokenId)
          .neq("route", EXCHANGE_ROUTE)
          .gte("at", since)
          .neq("id", row.id)
          .order("at", { ascending: true })
          .limit(100),
      ]);
      if (knownRes.error) throw knownRes.error;
      if (recentRes.error) throw recentRes.error;
      const known: KnownSet = { countries: new Set(), networks: new Set() };
      for (const k of knownRes.data ?? []) (k.kind === "country" ? known.countries : known.networks).add(k.value);
      const recent: RecentHit[] = (recentRes.data ?? []).map((r) => ({
        at: new Date(r.at),
        network: networkKey(r.ip, r.asn),
        country: r.country,
      }));
      const drafts = evaluateAlerts({ at: meta.at, network: meta.network, country: meta.country }, known, recent);
      for (const d of drafts) await insertAlert(d, ctx.tokenId, ctx.deviceId);
      return;
    }

    if (status === 401 || status === 403) {
      const since = new Date(meta.at.getTime() - 5 * 60_000).toISOString();
      const base = () =>
        db().from("access_log").select("id", { count: "exact", head: true }).is("token_id", null).in("result", [401, 403]).gte("at", since);
      const [g, i] = await Promise.all([base(), meta.ip ? base().eq("ip", meta.ip) : null]);
      if (g.error) throw g.error;
      if (i?.error) throw i.error;
      const d = evaluateAuthBurst(g.count ?? 0, i?.count ?? 0, meta.ip);
      if (d) await insertAlert(d, null, null);
    }
  } catch (e) {
    logErr("log", e); // swallowed: logging must never affect the request
  }
}

export async function trustAlert(alertId: string): Promise<void> {
  const s = db();
  const { data: a, error } = await s.from("alerts").select("id, rule, value, device_id").eq("id", alertId).maybeSingle();
  if (error) throw error;
  if (!a) throw new ApiError(404, "NOT_FOUND", "Alert not found");
  if (a.device_id && a.rule !== "auth_burst") {
    const kind = a.rule === "new_country" ? "country" : "network";
    const values: string[] = kind === "country" ? [a.value] : String(a.value).split(",");
    const rows = values.filter(Boolean).map((value) => ({ device_id: a.device_id, kind, value, trusted_by: "admin" }));
    const ins = await s.from("device_known").upsert(rows, { onConflict: "device_id,kind,value", ignoreDuplicates: true });
    if (ins.error) throw ins.error;
  }
  const up = await s.from("alerts").update({ status: "trusted", read_at: new Date().toISOString() }).eq("id", alertId);
  if (up.error) throw up.error;
}

export async function dismissAlert(alertId: string): Promise<void> {
  const { data, error } = await db()
    .from("alerts")
    .update({ status: "dismissed", read_at: new Date().toISOString() })
    .eq("id", alertId)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new ApiError(404, "NOT_FOUND", "Alert not found");
}

export async function listAlerts(status?: string): Promise<unknown[]> {
  let q = db().from("alerts").select("*").order("created_at", { ascending: false }).limit(200);
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

// ---------------------------------------------------------------------------------------------------------------
// Unclaimed-task ("stale task") alert. Notify only: nobody claims on the strength of an alert (R2/R3 unchanged).
// A task is stale when it is open, handed to somebody (handoff_to set), unclaimed and has waited longer than
// STALE_TASK_MIN_MINUTES (default 30). Pure helpers here; the poll surfaces (lib/handlers.ts list_tasks + inbox) and
// the dashboard (lib/dash/board.ts) share them so the wording and the clock never drift.
// ---------------------------------------------------------------------------------------------------------------

export const STALE_TASK_MIN_MINUTES = 30;
export const STALE_ACTIVE_MIN_MINUTES = 10;
/** Max alerts one poll carries; the rest follow on the next poll. */
export const STALE_ALERTS_PER_POLL = 5;
/** task_events marker: "this identity was shown the alert for this task" (the dedupe record; no schema change). */
export const STALE_EVENT = { kind: "update", note: "stale-alert" } as const;

function minutesEnv(raw: string | undefined, dflt: number): number {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** X (stale threshold) and the "active" window (agent@machine seen polling within it), both env-injectable. */
export function staleConfig(env: Record<string, string | undefined> = process.env): { staleMs: number; activeMs: number } {
  return {
    staleMs: minutesEnv(env.STALE_TASK_MIN_MINUTES, STALE_TASK_MIN_MINUTES) * 60_000,
    activeMs: minutesEnv(env.STALE_ACTIVE_MIN_MINUTES, STALE_ACTIVE_MIN_MINUTES) * 60_000,
  };
}

/** Whole minutes a task has waited. Clock = updated_at (creation, handoff and release all set it), else created_at. */
export function waitingMinutes(t: { updated_at?: string | null; created_at: string }, nowMs: number = Date.now()): number {
  const since = Date.parse(t.updated_at ?? t.created_at);
  return Number.isFinite(since) ? Math.max(0, Math.floor((nowMs - since) / 60_000)) : 0;
}

/** "unclaimed task for <Y>: <title>, waiting N min". Titles are untrusted: control chars and JSON/shell-hostile characters removed, <= 120 chars. */
export function staleAlertText(t: { handoff_to: string; title: string }, minutes: number): string {
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\[\]{}]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `unclaimed task for ${clean(t.handoff_to)}: ${clean(t.title)}, waiting ${minutes} min`;
}
