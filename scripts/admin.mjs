#!/usr/bin/env node
// agency-board admin CLI (Node 20+, ESM, no dependencies).
// Reads AGENCY_BOARD_ADMIN_TOKEN and AGENCY_BOARD_BASE_URL from the environment, else from ../.env.local
// (relative to this file). The admin token is only ever sent as a bearer header; it is never printed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `usage: node scripts/admin.mjs <command> [args]

  issue-code --machine <name> --agents <a,b,..> [--os mac|windows|linux]
  devices
  rotate <deviceId>                 revoke the device's tokens + issue a new connect code
  revoke <deviceId>
  revoke-agent <agent>
  flags [--dispatch-paused true|false] [--writes-frozen true|false]
  alerts [--status open|trusted|dismissed|...]
  trust <alertId>
  dismiss <alertId>
  inbox
  approve <memId> [--namespace ns]
  reject <memId>
  approvals [--status pending|approved|denied|expired]
  decide <approvalId> approved|denied [--answer txt]
  backfill [--limit 1-64]

  identities                        every agent@device with role, grants, last heartbeat
  role <agent> <deviceId> <director|lead|member>
  projects                          confidential projects + grant counts
  project-add <slug> <name>
  project-rename <slug> <name>
  grant <agent> <deviceId> <slug>   allow agent@device to read/write a confidential project
  ungrant <agent> <deviceId> <slug>
  audit [--limit n]                 recent role / grant / project changes

env: AGENCY_BOARD_ADMIN_TOKEN (agency-board-admin_...), AGENCY_BOARD_BASE_URL (e.g. https://<app>.vercel.app); else read from .env.local
      AGENCY_BOARD_AGENTS (comma list of agent ids, default claude,codex,hermes,grok; must match the server)`;

function fromEnvFile(keys) {
  const out = {};
  let text;
  try {
    text = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || !keys.includes(m[1])) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function die(msg) {
  console.error(`admin: ${msg}`);
  process.exit(1);
}

// argv -> { pos: [...], opt: {name: value} }; every --flag takes one value.
function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opt.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.includes("=") ? [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a.slice(2), argv[++i]];
      if (v === undefined) die(`--${k} needs a value`);
      opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}

function bool(v, name) {
  if (v === undefined) return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  die(`--${name} must be true or false`);
}

// Same list and id format as the server (lib/config.ts: AGENCY_BOARD_AGENTS, ^[a-z][a-z0-9]{1,23}$); the server stays authoritative.
const AGENTS = (process.env.AGENCY_BOARD_AGENTS || "claude,codex,hermes,grok")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ROLES = ["director", "lead", "member"];

// raw (unencoded) required positional, for JSON bodies
function raw(v, what) {
  if (!v) die(`missing ${what}\n\n${USAGE}`);
  return v;
}

function agentArg(v) {
  if (!AGENTS.includes(raw(v, "agent"))) die(`agent must be one of ${AGENTS.join(", ")}`);
  return v;
}

function need(v, what) {
  if (!v) die(`missing ${what}\n\n${USAGE}`);
  return encodeURIComponent(v);
}

const { pos, opt } = parseArgs(process.argv.slice(2));
const cmd = pos[0];
if (!cmd || opt.help || cmd === "help") {
  console.log(USAGE);
  process.exit(cmd || opt.help ? 0 : 1);
}

// [method, path, body?]
function route() {
  const a = pos[1];
  switch (cmd) {
    case "issue-code": {
      if (!opt.machine || !opt.agents) die(`issue-code needs --machine and --agents\n\n${USAGE}`);
      const body = { machine_name: opt.machine, agents: opt.agents.split(",").map((s) => s.trim()).filter(Boolean) };
      if (opt.os) body.os = opt.os;
      return ["POST", "connect-codes", body];
    }
    case "devices": return ["GET", "devices"];
    case "rotate": return ["POST", `devices/${need(a, "deviceId")}/rotate`];
    case "revoke": return ["POST", `devices/${need(a, "deviceId")}/revoke`];
    case "revoke-agent": return ["POST", `agents/${need(a, "agent")}/revoke`];
    case "flags": {
      const body = {};
      const d = bool(opt["dispatch-paused"], "dispatch-paused");
      const w = bool(opt["writes-frozen"], "writes-frozen");
      if (d !== undefined) body.dispatch_paused = d;
      if (w !== undefined) body.writes_frozen = w;
      return Object.keys(body).length ? ["POST", "flags", body] : ["GET", "flags"];
    }
    case "alerts": return ["GET", opt.status ? `alerts?status=${encodeURIComponent(opt.status)}` : "alerts"];
    case "trust": return ["POST", `alerts/${need(a, "alertId")}/trust`];
    case "dismiss": return ["POST", `alerts/${need(a, "alertId")}/dismiss`];
    case "inbox": return ["GET", "inbox"];
    case "approve": return ["POST", `inbox/${need(a, "memId")}/approve`, opt.namespace ? { namespace: opt.namespace } : {}];
    case "reject": return ["POST", `inbox/${need(a, "memId")}/reject`];
    case "approvals": return ["GET", opt.status ? `approvals?status=${encodeURIComponent(opt.status)}` : "approvals"];
    case "decide": {
      const decision = pos[2];
      if (decision !== "approved" && decision !== "denied") die(`decide needs approved|denied\n\n${USAGE}`);
      const body = { decision };
      if (opt.answer !== undefined) body.answer = opt.answer;
      return ["POST", `approvals/${need(a, "approvalId")}`, body];
    }
    case "backfill": {
      const body = {};
      if (opt.limit !== undefined) body.limit = Number(opt.limit);
      return ["POST", "backfill", body];
    }
    case "identities": return ["GET", "identities"];
    case "role": {
      const role = raw(pos[3], "role");
      if (!ROLES.includes(role)) die(`role must be one of ${ROLES.join(", ")}`);
      return ["POST", "roles", { agent: agentArg(a), device_id: raw(pos[2], "deviceId"), role }];
    }
    case "projects": return ["GET", "confidential"];
    case "project-add":
      return ["POST", "confidential", { slug: raw(a, "slug"), name: raw(pos.slice(2).join(" "), "name") }];
    case "project-rename":
      return ["PATCH", `confidential/${need(a, "slug")}`, { name: raw(pos.slice(2).join(" "), "name") }];
    case "grant":
    case "ungrant":
      return ["POST", "grants", {
        agent: agentArg(a), device_id: raw(pos[2], "deviceId"), project: raw(pos[3], "slug"), granted: cmd === "grant",
      }];
    case "audit": {
      if (opt.limit !== undefined && !/^\d+$/.test(opt.limit)) die("--limit must be a positive integer");
      return ["GET", opt.limit !== undefined ? `audit?limit=${opt.limit}` : "audit"];
    }
    default: die(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

const [method, path, body] = route();
const file = fromEnvFile(["AGENCY_BOARD_ADMIN_TOKEN", "AGENCY_BOARD_BASE_URL"]);
const token = process.env.AGENCY_BOARD_ADMIN_TOKEN || file.AGENCY_BOARD_ADMIN_TOKEN;
const base = (process.env.AGENCY_BOARD_BASE_URL || file.AGENCY_BOARD_BASE_URL || "").replace(/\/+$/, "");
if (!token) die("AGENCY_BOARD_ADMIN_TOKEN is not set (env or .env.local)");
if (!token.startsWith("agency-board-admin_")) die("AGENCY_BOARD_ADMIN_TOKEN must be a agency-board-admin_ token");
if (!/^https?:\/\//.test(base)) die("AGENCY_BOARD_BASE_URL is not set (env or .env.local), e.g. https://<app>.vercel.app");

let res;
try {
  res = await fetch(`${base}/api/admin/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(method !== "GET" ? { "content-type": "application/json" } : {}) },
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
} catch (e) {
  die(`request to ${base} failed: ${e?.cause?.code ?? e?.name ?? "error"}`);
}
const text = await res.text();
let parsed;
try {
  parsed = JSON.parse(text);
} catch {
  die(`HTTP ${res.status}: non-JSON response`);
}
if (!res.ok) {
  const err = parsed?.error ?? {};
  die(`HTTP ${res.status} ${err.code ?? ""}: ${err.message ?? text.slice(0, 300)}`);
}
const data = parsed?.data ?? parsed;
if ((cmd === "issue-code" || cmd === "rotate") && data?.code) {
  console.log(`code ${data.code} (expires ${data.expiresAt}, single use)\n`);
  console.log(`Mac/Linux:\n  ${data.commands.mac}\n\nWindows PowerShell:\n  ${data.commands.windows}`);
} else {
  console.log(JSON.stringify(data, null, 2));
}
