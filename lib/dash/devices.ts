import { z } from "zod";
import { listAlerts } from "../access";
import { DEVICE_AGENTS, isRestricted } from "../config";
import { db } from "../db";
import { listListenMinutes, parseListenMinutes } from "../agentSettings";
import { hasListenSlider, listenKey } from "./listen";
import { listDevices } from "../devices";
import type { AgentId, Role } from "../types";

// B-DEVICES (§18): data + pure helpers for /dashboard/devices. Server-only (service role).
// Pure helpers at the top are unit-tested in tests/dash-devices.test.ts.

// ---------- pure helpers ----------

export type AlertRule = "new_country" | "concurrent_use" | "new_network" | "auth_burst";
export type DeviceOs = "mac" | "windows" | "linux";
export const DEVICE_OS: readonly DeviceOs[] = ["mac", "windows", "linux"] as const;
/** Agents the dashboard can issue connect codes for (AGENCY_BOARD_DEVICE_AGENTS; cloud-only bots are left out). */
export const CONNECT_AGENTS: readonly AgentId[] = DEVICE_AGENTS;
export const MACHINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RESTRICTED_WARNING =
  "A restricted agent stays read/write capped at every role. Granting it a confidential project or a higher role needs explicit confirmation.";

/** One format for networks everywhere (overview + devices): "asn:13335" -> "AS13335"; "net:1.2.3.0/24" -> "1.2.3.0/24"; anything else unchanged. */
export function describeNetwork(value: string): string {
  if (value.startsWith("asn:")) return `AS${value.slice(4)}`;
  if (value.startsWith("net:")) return value.slice(4);
  return value;
}

/** The rule in plain words, without the subject: "used from a new country (SG)". */
export function alertRuleText(rule: string, value: string): string {
  switch (rule) {
    case "new_country":
      return `used from a new country (${value})`;
    case "concurrent_use": {
      const nets = value.split(",").filter(Boolean).map(describeNetwork);
      return nets.length ? `alternating between networks (${nets.join(", ")})` : "alternating between networks";
    }
    case "new_network":
      return `used from a new network (${describeNetwork(value)})`;
    case "auth_burst":
      return value === "global" ? "burst of failed sign-ins across all addresses" : `burst of failed sign-ins from ${value}`;
    default:
      return `unrecognised alert (${rule})`;
  }
}

/** Full sentence: "claude@laptop used from a new country (SG)". auth_burst has no subject. */
export function alertSentence(rule: string, value: string, subject: string | null): string {
  const text = alertRuleText(rule, value);
  if (rule === "auth_burst" || !subject) return text.charAt(0).toUpperCase() + text.slice(1);
  return `${subject} ${text}`;
}

/**
 * Vendor limit, not config: the built-in Windows connector (connect.ps1, contract §7) has no step for the hermes CLI,
 * so that one agent name is mac/linux only. Every other agent is allowed everywhere. Unknown OS -> allowed.
 */
export function agentAllowedOnOs(agent: AgentId, os: DeviceOs | null | undefined): boolean {
  return !(agent === "hermes" && os === "windows");
}

/** Drops agents the OS cannot run; returns the kept list (deduplicated, input order). */
export function agentsForOs(agents: AgentId[], os: DeviceOs | null | undefined): AgentId[] {
  return Array.from(new Set(agents)).filter((a) => agentAllowedOnOs(a, os));
}

// ---------- listen/wait slider (Addendum 2: 0-60 minutes, step 1, default 30, 0 = off) ----------
// Pure helpers live in ./listen (client-safe, no db import) and are re-exported here.
export { LISTEN_AGENTS, hasListenSlider, listenKey, listenLabel, sliderMinutes } from "./listen";

/** Server-side validation of the slider post: agent allow-list, uuid device id, integer 0..60. null = invalid. */
export function parseListenForm(fd: { get(name: string): unknown }): { agent: AgentId; device_id: string; minutes: number } | null {
  const agent = String(fd.get("agent") ?? "");
  const device = String(fd.get("device_id") ?? "");
  const minutes = parseListenMinutes(fd.get("minutes"));
  if (!hasListenSlider(agent) || minutes === null || !z.uuid().safeParse(device).success) return null;
  return { agent: agent as AgentId, device_id: device, minutes };
}

/** Stored intervals for the identities that get a slider; missing row/table -> not in the map (page shows the default). Never throws. */
export async function loadListenMinutes(ids: Array<{ agent: string; device_id: string }>): Promise<Map<string, number>> {
  const slider = ids.filter((i) => hasListenSlider(i.agent));
  const all = await listListenMinutes(Array.from(new Set(slider.map((i) => i.device_id))));
  const wanted = new Set(slider.map((i) => listenKey(i.agent, i.device_id)));
  return new Map([...all].filter(([k]) => wanted.has(k)));
}

export interface RoleHolder {
  agent: AgentId;
  device_id: string;
  machine: string;
  role: Role;
}

export function identLabel(i: { agent: string; machine: string }): string {
  return i.machine ? `${i.agent}@${i.machine}` : i.agent;
}

/**
 * Which identity gets demoted to lead if `target` is promoted to director (one director at a time, §11).
 * null when nobody (no current director, or the target already is the director).
 */
export function directorToDemote(identities: RoleHolder[], target: { agent: string; device_id: string }): RoleHolder | null {
  const cur = identities.find((i) => i.role === "director");
  if (!cur) return null;
  if (cur.agent === target.agent && cur.device_id === target.device_id) return null;
  return cur;
}

/** Changing this identity to `next` shows the restricted-agent warning (a restricted agent promoted to lead or director). */
export function needsRestrictedWarning(agent: string, from: Role, next: Role): boolean {
  const rank: Record<Role, number> = { member: 0, lead: 1, director: 2 };
  return isRestricted(agent) && next !== "member" && rank[next] > rank[from];
}

/** Base URL for connect commands: AGENCY_BOARD_BASE_URL, else the request origin from forwarded headers. */
export function baseUrlFrom(env: string | undefined, h: { get(name: string): string | null }): string {
  if (env && env.trim()) return env.trim().replace(/\/+$/, "");
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost";
  const proto = (h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")).split(",")[0].trim();
  return `${proto}://${host.split(",")[0].trim()}`;
}

// ---------- data ----------

interface DeviceToken {
  id: string;
  agent: AgentId;
  token_prefix: string;
  created_at: string;
  last_used_at: string | null;
  last_heartbeat_at: string | null;
  model: string | null;
  revoked_at: string | null;
}
interface DeviceRaw {
  id: string;
  machine_name: string;
  os: DeviceOs | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  tokens: DeviceToken[];
}

export interface LastAccess {
  at: string;
  ip: string | null;
  country: string | null;
  city: string | null;
}

export interface DeviceView {
  id: string;
  machine: string;
  os: DeviceOs | null;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  agents: AgentId[]; // agents with a live (non-revoked) token
  last: LastAccess | null;
  known_countries: string[];
  known_networks: string[];
}

export interface AlertView {
  id: string;
  rule: AlertRule | string;
  severity: "red" | "yellow";
  value: string;
  created_at: string;
  read_at: string | null;
  device_id: string | null;
  machine: string | null;
  subject: string | null; // agent@machine, or machine when the token is unknown
  token_prefix: string | null;
  rule_text: string; // rule in plain words, no subject
  sentence: string; // subject + rule_text (capitalised rule_text when there is no subject)
}

// Throws with the Postgres code only (never row content); the page renders an inline error card.
function q<T>(res: { data: T | null; error: { code?: string; message?: string } | null }, what: string): T | null {
  if (res.error) throw new Error(`dash/devices: ${what} failed (${res.error.code ?? "unknown"})`);
  return res.data;
}

/**
 * Newest access_log row per device in ONE query (no N+1). PostgREST has no DISTINCT ON, so each device
 * contributes only rows in a 10-minute window ending at its last_seen_at (which logAndEvaluate sets to the
 * same `at` as the row it inserts); the newest row per device is then picked in JS.
 */
async function lastAccessByDevice(devices: Array<{ id: string; last_seen_at: string | null }>): Promise<Map<string, LastAccess>> {
  const out = new Map<string, LastAccess>();
  const seen = devices.filter((d) => d.last_seen_at);
  if (seen.length === 0) return out;
  const clauses = seen.map((d) => {
    const from = new Date(new Date(d.last_seen_at!).getTime() - 10 * 60_000).toISOString();
    return `and(device_id.eq.${d.id},at.gte.${from})`;
  });
  const rows = (q(
    await db()
      .from("access_log")
      .select("device_id, at, ip, country, city")
      .or(clauses.join(","))
      .order("at", { ascending: false })
      .limit(2000),
    "last access",
  ) ?? []) as Array<{ device_id: string; at: string; ip: string | null; country: string | null; city: string | null }>;
  for (const r of rows) {
    if (!out.has(r.device_id)) out.set(r.device_id, { at: r.at, ip: r.ip, country: r.country?.trim() || null, city: r.city });
  }
  return out;
}

/**
 * Everything the devices page needs except identities, from one listDevices() call plus three parallel
 * queries (open alerts, newest access row per device, device_known). No N+1.
 */
export async function loadDevicesPage(): Promise<{ devices: DeviceView[]; alerts: AlertView[] }> {
  const raw = (await listDevices()) as DeviceRaw[];
  const [alerts, last, knownRows] = await Promise.all([
    listAlerts("open"),
    lastAccessByDevice(raw),
    db().from("device_known").select("device_id, kind, value").order("at", { ascending: true }),
  ]);
  const known = (q(knownRows, "device_known") ?? []) as Array<{ device_id: string; kind: "country" | "network"; value: string }>;

  const devices: DeviceView[] = raw
    .map((d) => {
      const k = known.filter((r) => r.device_id === d.id);
      return {
        id: d.id,
        machine: d.machine_name,
        os: d.os,
        created_at: d.created_at,
        last_seen_at: d.last_seen_at,
        revoked_at: d.revoked_at,
        agents: Array.from(new Set(d.tokens.filter((t) => !t.revoked_at).map((t) => t.agent))).sort(),
        last: last.get(d.id) ?? null,
        known_countries: k.filter((r) => r.kind === "country").map((r) => r.value),
        known_networks: k.filter((r) => r.kind === "network").map((r) => describeNetwork(r.value)),
      };
    })
    .sort((a, b) => Number(!!a.revoked_at) - Number(!!b.revoked_at) || a.machine.localeCompare(b.machine));

  const byId = new Map(raw.map((d) => [d.id, d]));
  const tokens = new Map<string, { agent: AgentId; prefix: string; machine: string }>();
  for (const d of raw) for (const t of d.tokens) tokens.set(t.id, { agent: t.agent, prefix: t.token_prefix, machine: d.machine_name });
  const alertViews: AlertView[] = (alerts as Array<{
    id: string; rule: string; severity: "red" | "yellow"; value: string; created_at: string; read_at: string | null;
    device_id: string | null; token_id: string | null;
  }>).map((a) => {
    const dev = a.device_id ? byId.get(a.device_id) : undefined;
    const tok = a.token_id ? tokens.get(a.token_id) : undefined;
    const machine = dev?.machine_name ?? tok?.machine ?? null;
    const subject = tok ? `${tok.agent}@${tok.machine}` : machine;
    return {
      id: a.id,
      rule: a.rule,
      severity: a.severity,
      value: a.value,
      created_at: a.created_at,
      read_at: a.read_at,
      device_id: a.device_id,
      machine,
      subject,
      token_prefix: tok?.prefix ?? null,
      rule_text: alertRuleText(a.rule, a.value),
      sentence: alertSentence(a.rule, a.value, subject),
    };
  });
  // red before yellow, newest first within a severity
  alertViews.sort((x, y) => Number(x.severity !== "red") - Number(y.severity !== "red") || y.created_at.localeCompare(x.created_at));
  return { devices, alerts: alertViews };
}

/** Explicit "Mark all read": sets read_at on open, unread alerts. Never called on render. */
export async function markAllAlertsRead(): Promise<number> {
  const rows = (q(
    await db().from("alerts").update({ read_at: new Date().toISOString() }).eq("status", "open").is("read_at", null).select("id"),
    "mark alerts read",
  ) ?? []) as Array<{ id: string }>;
  return rows.length;
}

/** After Rotate / Disable from an alert card: close the alert with the matching status. */
export async function closeAlert(alertId: string, status: "rotated" | "disabled"): Promise<void> {
  q(
    await db().from("alerts").update({ status, read_at: new Date().toISOString() }).eq("id", alertId).eq("status", "open").select("id"),
    "close alert",
  );
}

/** Machine name + OS for server-side re-checks (typed confirmation, agent-on-OS check). */
export async function deviceBasics(deviceId: string): Promise<{ machine: string; os: DeviceOs | null } | null> {
  const row = q(
    await db().from("devices").select("machine_name, os").eq("id", deviceId).maybeSingle(),
    "device lookup",
  ) as { machine_name: string; os: DeviceOs | null } | null;
  return row ? { machine: row.machine_name, os: row.os } : null;
}
