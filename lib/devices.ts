import { randomInt } from "node:crypto";
import { db } from "./db";
import { newAgentToken, sha256hex } from "./auth";
import { assertConfidentialTiers } from "./guard";
import { defaultRole } from "./scopes";
import { AGENTS, ApiError, type AgentId, type RequestMeta } from "./types";

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
const CODE_LEN = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const MACHINE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OS_VALUES = ["mac", "windows", "linux"] as const;
type Os = (typeof OS_VALUES)[number];

type ConnectCodeResult = { code: string; expiresAt: string; commands: { mac: string; windows: string } };

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function check<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`devices: ${what} failed: ${res.error.message}`);
  return res.data;
}

function asOs(v: unknown): Os | null {
  return typeof v === "string" && (OS_VALUES as readonly string[]).includes(v) ? (v as Os) : null;
}

// Uppercase, drop spaces/dashes so "abcd-efgh" works too.
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

export function connectCommands(base: string, code: string): { mac: string; windows: string } {
  return {
    mac: `curl -fsSL ${base}/connect.sh | sh -s ${code}`,
    windows: `$env:AGENCY_BOARD_CODE='${code}'; irm ${base}/connect.ps1 | iex`,
  };
}

export async function issueConnectCode(
  p: { machineName: string; os?: "mac" | "windows" | "linux"; agents: AgentId[] },
  baseUrl: string,
): Promise<ConnectCodeResult> {
  if (typeof p.machineName !== "string" || !MACHINE_RE.test(p.machineName)) {
    fail(422, "VALIDATION", "machine_name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$");
  }
  // §13: the machine name becomes part of every identity (agent@machine) and task note; never a phone / ID number.
  assertConfidentialTiers({ ok: false }, p.machineName); // no namespace: contracts only with a confidential marker
  if (p.os !== undefined && !asOs(p.os)) fail(422, "VALIDATION", "os must be mac|windows|linux");
  const agents = Array.from(new Set(p.agents ?? []));
  if (agents.length === 0 || agents.some((a) => !AGENTS.includes(a))) {
    fail(422, "VALIDATION", `agents must be a non-empty subset of ${AGENTS.join(",")}`);
  }

  let code = "";
  for (let i = 0; i < CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString();

  check(
    await db().from("connect_codes").insert({
      code_hash: sha256hex(code),
      machine_name: p.machineName,
      os: p.os ?? null,
      agents,
      expires_at: expiresAt,
    }),
    "insert connect_code",
  );

  const base = baseUrl.replace(/\/+$/, "");
  return { code, expiresAt, commands: connectCommands(base, code) };
}

export async function exchangeCode(
  p: { code: string; hostname?: string; os?: string },
  meta: RequestMeta,
): Promise<{
  serverUrl?: string;
  machine: string;
  deviceId: string;
  tokens: Partial<Record<AgentId, string>>;
  /** Ids of the tokens just created (never the values): for the exchange access_log rows. */
  issued: Array<{ tokenId: string; agent: AgentId }>;
}> {
  const code = normalizeCode(typeof p.code === "string" ? p.code : "");
  if (code.length !== CODE_LEN) fail(400, "CODE_INVALID", "connect code is invalid");
  const codeHash = sha256hex(code);
  const nowIso = new Date().toISOString();

  // Atomic single-use: only one caller can flip used_at from null.
  const claimed = check(
    await db()
      .from("connect_codes")
      .update({ used_at: nowIso, used_ip: meta.ip })
      .eq("code_hash", codeHash)
      .is("used_at", null)
      .gt("expires_at", nowIso)
      .select("machine_name, os, agents"),
    "claim connect_code",
  ) as Array<{ machine_name: string; os: string | null; agents: string[] }>;

  if (claimed.length === 0) {
    const row = check(
      await db().from("connect_codes").select("used_at, expires_at").eq("code_hash", codeHash).maybeSingle(),
      "lookup connect_code",
    ) as { used_at: string | null; expires_at: string } | null;
    if (!row) fail(400, "CODE_INVALID", "connect code is invalid");
    if (row.used_at) fail(410, "CODE_USED", "connect code was already used");
    fail(410, "CODE_EXPIRED", "connect code has expired");
  }

  const c = claimed[0];
  const os = asOs(c.os) ?? asOs(p.os);
  const device = check(
    await db()
      .from("devices")
      .upsert(
        { machine_name: c.machine_name, ...(os ? { os } : {}), revoked_at: null, last_seen_at: nowIso },
        { onConflict: "machine_name" },
      )
      .select("id")
      .single(),
    "upsert device",
  ) as { id: string };

  check(
    await db().from("connect_codes").update({ device_id: device.id }).eq("code_hash", codeHash),
    "link connect_code",
  );

  const tokens: Partial<Record<AgentId, string>> = {};
  const issued: Array<{ tokenId: string; agent: AgentId }> = [];
  for (const agent of c.agents.filter((a): a is AgentId => AGENTS.includes(a as AgentId))) {
    check(
      await db()
        .from("agent_tokens")
        .update({ revoked_at: nowIso })
        .eq("device_id", device.id)
        .eq("agent", agent)
        .is("revoked_at", null),
      "revoke old tokens",
    );
    const t = newAgentToken(agent);
    const tok = check(
      await db()
        .from("agent_tokens")
        .insert({ agent, device_id: device.id, token_hash: t.hash, token_prefix: t.prefix })
        .select("id")
        .single(),
      "insert token",
    ) as { id: string };
    issued.push({ tokenId: tok.id, agent });
    // CONTRACT §11: default role if absent; never overwrite a role the owner already set.
    check(
      await db()
        .from("agent_roles")
        .upsert({ agent, device_id: device.id, role: defaultRole(agent) }, { onConflict: "agent,device_id", ignoreDuplicates: true }),
      "seed agent_role",
    );
    tokens[agent] = t.raw;
  }

  const known = [
    meta.country ? { device_id: device.id, kind: "country", value: meta.country, trusted_by: "connect" } : null,
    meta.network ? { device_id: device.id, kind: "network", value: meta.network, trusted_by: "connect" } : null,
  ].filter((r) => r !== null);
  if (known.length) {
    check(
      await db().from("device_known").upsert(known, { onConflict: "device_id,kind,value", ignoreDuplicates: true }),
      "seed device_known",
    );
  }

  return { machine: c.machine_name, deviceId: device.id, tokens, issued };
}

async function revokeDeviceTokens(deviceId: string): Promise<void> {
  check(
    await db()
      .from("agent_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("device_id", deviceId)
      .is("revoked_at", null),
    "revoke device tokens",
  );
}

async function getDevice(deviceId: string): Promise<{ id: string; machine_name: string; os: string | null }> {
  const d = check(
    await db().from("devices").select("id, machine_name, os").eq("id", deviceId).maybeSingle(),
    "lookup device",
  ) as { id: string; machine_name: string; os: string | null } | null;
  if (!d) fail(404, "NOT_FOUND", "device not found");
  return d;
}

export async function rotateDevice(deviceId: string, baseUrl: string): Promise<ConnectCodeResult> {
  const d = await getDevice(deviceId);
  const rows = check(
    await db().from("agent_tokens").select("agent").eq("device_id", deviceId),
    "list device agents",
  ) as Array<{ agent: AgentId }>;
  let agents = Array.from(new Set(rows.map((r) => r.agent)));
  if (agents.length === 0) {
    const last = check(
      await db()
        .from("connect_codes")
        .select("agents")
        .eq("machine_name", d.machine_name)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      "last connect_code",
    ) as { agents: AgentId[] } | null;
    agents = last?.agents ?? [];
  }
  if (agents.length === 0) fail(409, "CONFLICT", "device has no known agents; issue a new code instead");
  await revokeDeviceTokens(deviceId);
  return issueConnectCode({ machineName: d.machine_name, os: asOs(d.os) ?? undefined, agents }, baseUrl);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  await getDevice(deviceId);
  check(
    await db().from("devices").update({ revoked_at: new Date().toISOString() }).eq("id", deviceId),
    "revoke device",
  );
  await revokeDeviceTokens(deviceId);
}

export async function revokeAgent(agent: AgentId): Promise<number> {
  if (!AGENTS.includes(agent)) fail(422, "VALIDATION", `agent must be one of ${AGENTS.join(",")}`);
  const rows = check(
    await db()
      .from("agent_tokens")
      .update({ revoked_at: new Date().toISOString() })
      .eq("agent", agent)
      .is("revoked_at", null)
      .select("id"),
    "revoke agent tokens",
  ) as Array<{ id: string }>;
  return rows.length;
}

// Never selects token_hash.
export async function listDevices(): Promise<unknown[]> {
  return check(
    await db()
      .from("devices")
      .select(
        "id, machine_name, os, created_at, last_seen_at, revoked_at, " +
          "tokens:agent_tokens(id, agent, token_prefix, created_at, last_used_at, last_heartbeat_at, model, status_note, revoked_at)",
      )
      .order("created_at", { ascending: true }),
    "list devices",
  ) as unknown[];
}
