// Single parse point for deployment configuration (server-side only).
// Client components MUST NOT import this module: it reads process.env. Pass values down as props instead.
//
// Env (all optional):
//   AGENCY_BOARD_AGENTS             comma list of agent ids            default "claude,codex,hermes,grok"
//   AGENCY_BOARD_LEAD_AGENTS        agents whose default role is lead  default "claude,codex" (others default to member)
//   AGENCY_BOARD_RESTRICTED_AGENTS  inbox-only capped agents           default "hermes"
//   AGENCY_BOARD_DEVICE_AGENTS      agents the dashboard can issue connect codes for   default "claude,codex,hermes"
//   AGENCY_BOARD_OWNER_NAME         owner display name in guide/API text               default "the operator"
//   AGENCY_BOARD_MEMORY_LANGUAGE    language memories are written in                   default "English"
//   AGENCY_BOARD_TIMEZONE           IANA zone used when printing times                 default "UTC"
// The database only knows the agent id FORMAT (see AGENT_ID_RE); membership is validated here.

export const AGENT_ID_RE = /^[a-z][a-z0-9]{1,23}$/;

export const TOKEN_PREFIX = "agency-board";
export const ADMIN_TOKEN_PREFIX = "agency-board-admin_";

function list(name: string, fallback: string): readonly string[] {
  const raw = (process.env[name] ?? "").trim() || fallback;
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!id) continue;
    if (!AGENT_ID_RE.test(id)) {
      throw new Error(`config: ${name} has invalid agent id "${id}" (must match ${AGENT_ID_RE.source})`);
    }
    if (!out.includes(id)) out.push(id);
  }
  if (out.length === 0) throw new Error(`config: ${name} is empty`);
  return Object.freeze(out);
}

// LEAD / RESTRICTED / DEVICE must be subsets of AGENTS. Set explicitly, a stray id throws (typo guard). Left unset, the
// built-in default is narrowed to the configured AGENTS instead, so a custom AGENTS list works without the other three.
function subsetOf(name: string, fallback: string, all: readonly string[]): readonly string[] {
  if (!(process.env[name] ?? "").trim()) return Object.freeze(fallback.split(",").filter((id) => all.includes(id)));
  const ids = list(name, fallback);
  for (const id of ids) {
    if (!all.includes(id)) throw new Error(`config: ${name} contains "${id}" which is not in AGENCY_BOARD_AGENTS`);
  }
  return ids;
}

export const AGENTS: readonly string[] = list("AGENCY_BOARD_AGENTS", "claude,codex,hermes,grok");
export const LEAD_AGENTS: readonly string[] = subsetOf("AGENCY_BOARD_LEAD_AGENTS", "claude,codex", AGENTS);
export const RESTRICTED_AGENTS: readonly string[] = subsetOf("AGENCY_BOARD_RESTRICTED_AGENTS", "hermes", AGENTS);
export const DEVICE_AGENTS: readonly string[] = subsetOf("AGENCY_BOARD_DEVICE_AGENTS", "claude,codex,hermes", AGENTS);

export const OWNER_NAME: string = (process.env.AGENCY_BOARD_OWNER_NAME ?? "").trim() || "the operator";
export const MEMORY_LANGUAGE: string = (process.env.AGENCY_BOARD_MEMORY_LANGUAGE ?? "").trim() || "English";
export const TIMEZONE: string = (() => {
  const tz = (process.env.AGENCY_BOARD_TIMEZONE ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
  } catch {
    throw new Error(`config: AGENCY_BOARD_TIMEZONE "${tz}" is not a valid IANA time zone (e.g. UTC, Europe/Berlin)`);
  }
  return tz;
})();

export function isAgentId(x: unknown): x is string {
  return typeof x === "string" && AGENTS.includes(x);
}

export function isRestricted(agent: string): boolean {
  return RESTRICTED_AGENTS.includes(agent);
}

export function defaultRole(agent: string): "lead" | "member" {
  return LEAD_AGENTS.includes(agent) ? "lead" : "member";
}
