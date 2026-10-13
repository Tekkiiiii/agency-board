// lib/config.ts (single parse point for AGENCY_BOARD_* deployment config) + token_prefix derivation + non-default agent sets.
// config is parsed at module load, so every case stubs env, resets the module registry and re-imports.
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import { newAgentToken, tokenPrefixLength, sha256hex } from "../lib/auth";
import { TOKEN_PREFIX } from "../lib/config";
import { db } from "../lib/db";
import { mintToken, cleanup } from "./helpers";

const KEYS = ["AGENCY_BOARD_AGENTS", "AGENCY_BOARD_LEAD_AGENTS", "AGENCY_BOARD_RESTRICTED_AGENTS", "AGENCY_BOARD_DEVICE_AGENTS", "AGENCY_BOARD_OWNER_NAME", "AGENCY_BOARD_MEMORY_LANGUAGE", "AGENCY_BOARD_TIMEZONE"];

async function load(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const k of KEYS) vi.stubEnv(k, env[k] ?? ""); // "" = unset (config trims and falls back to the default)
  return import("../lib/config");
}
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });
afterAll(cleanup);

describe("lib/config defaults", () => {
  it("documented defaults", async () => {
    const c = await load();
    expect([...c.AGENTS]).toEqual(["claude", "codex", "hermes", "grok"]);
    expect([...c.LEAD_AGENTS]).toEqual(["claude", "codex"]);
    expect([...c.RESTRICTED_AGENTS]).toEqual(["hermes"]);
    expect([...c.DEVICE_AGENTS]).toEqual(["claude", "codex", "hermes"]);
    expect([c.OWNER_NAME, c.MEMORY_LANGUAGE, c.TIMEZONE]).toEqual(["the operator", "English", "UTC"]);
    expect([c.TOKEN_PREFIX, c.ADMIN_TOKEN_PREFIX]).toEqual(["agency-board", "agency-board-admin_"]);
  });

  it("helpers follow the defaults", async () => {
    const c = await load();
    expect(c.isAgentId("grok")).toBe(true);
    expect(c.isAgentId("nobody")).toBe(false);
    expect(c.isAgentId(7)).toBe(false);
    expect(c.isRestricted("hermes")).toBe(true);
    expect(c.isRestricted("claude")).toBe(false);
    expect(["claude", "codex"].map(c.defaultRole)).toEqual(["lead", "lead"]);
    expect(["hermes", "grok"].map(c.defaultRole)).toEqual(["member", "member"]);
  });

  it("owner / language / timezone overrides are trimmed", async () => {
    const c = await load({ AGENCY_BOARD_OWNER_NAME: "  Ada  ", AGENCY_BOARD_MEMORY_LANGUAGE: " German ", AGENCY_BOARD_TIMEZONE: " Europe/Berlin " });
    expect([c.OWNER_NAME, c.MEMORY_LANGUAGE, c.TIMEZONE]).toEqual(["Ada", "German", "Europe/Berlin"]);
  });
});

describe("lib/config validation", () => {
  const set = (agents: string) => ({ AGENCY_BOARD_AGENTS: agents, AGENCY_BOARD_LEAD_AGENTS: "alpha", AGENCY_BOARD_RESTRICTED_AGENTS: "alpha", AGENCY_BOARD_DEVICE_AGENTS: "alpha" });

  it("dedupes and trims, keeping first-seen order", async () => {
    const c = await load(set(" alpha, beta ,alpha,,beta,gamma"));
    expect([...c.AGENTS]).toEqual(["alpha", "beta", "gamma"]);
  });

  it.each(["Alpha", "1abc", "a", "has-dash", "snake_case", "x".repeat(25)])("bad agent id %s throws", async (bad) => {
    await expect(load(set(`alpha,${bad}`))).rejects.toThrow(/invalid agent id/);
  });

  it("accepts the 2 and 24 character boundaries", async () => {
    const long = "a" + "b".repeat(23);
    const c = await load({ AGENCY_BOARD_AGENTS: `ab,${long}`, AGENCY_BOARD_LEAD_AGENTS: "ab", AGENCY_BOARD_RESTRICTED_AGENTS: "ab", AGENCY_BOARD_DEVICE_AGENTS: "ab" });
    expect([...c.AGENTS]).toEqual(["ab", long]);
  });

  it.each(["AGENCY_BOARD_LEAD_AGENTS", "AGENCY_BOARD_RESTRICTED_AGENTS", "AGENCY_BOARD_DEVICE_AGENTS"])("%s must be a subset of AGENCY_BOARD_AGENTS", async (key) => {
    await expect(load({ ...set("alpha,beta"), [key]: "alpha,ghost" })).rejects.toThrow(/not in AGENCY_BOARD_AGENTS/);
  });

  it("a bad id in a subset list is rejected by format first", async () => {
    await expect(load({ ...set("alpha"), AGENCY_BOARD_LEAD_AGENTS: "Bad!" })).rejects.toThrow(/invalid agent id/);
  });
});

describe("non-default agent sets", () => {
  const custom = { AGENCY_BOARD_AGENTS: "claude,codex,hermes,grok,newbot", AGENCY_BOARD_LEAD_AGENTS: "claude,newbot", AGENCY_BOARD_RESTRICTED_AGENTS: "grok", AGENCY_BOARD_DEVICE_AGENTS: "claude,newbot" };

  it("roles and the restricted cap follow AGENCY_BOARD_LEAD_AGENTS / AGENCY_BOARD_RESTRICTED_AGENTS", async () => {
    const c = await load(custom);
    expect(["claude", "codex", "newbot", "grok"].map(c.defaultRole)).toEqual(["lead", "member", "lead", "member"]);
    expect(c.isRestricted("grok")).toBe(true);
    expect(c.isRestricted("hermes")).toBe(false);
    const { scopesForRole } = await import("../lib/scopes");
    // grok is the restricted agent here: capped at every role, in its own namespace
    for (const role of ["director", "lead", "member"] as const) {
      expect(scopesForRole("grok", role, [])).toEqual({ readNs: ["grok/*", "shared/inbox"], writeNs: ["shared/inbox"], inboxOnly: true });
    }
    // hermes is an ordinary agent under this config
    expect(scopesForRole("hermes", "lead", [])).toEqual({ readNs: ["*"], writeNs: ["*"], inboxOnly: false });
    expect(scopesForRole("hermes", "member", []).inboxOnly).toBe(false);
  });

  it("the board resolves a configured lead agent's default role from p_lead_agents (live DB)", async () => {
    const t = await mintToken("grok", { machine: "cfg" });
    const asLead = await load({ ...custom, AGENCY_BOARD_LEAD_AGENTS: "claude,grok", AGENCY_BOARD_RESTRICTED_AGENTS: "hermes" });
    expect(asLead.defaultRole("grok")).toBe("lead");
    const { authenticateToken } = await import("../lib/auth");
    expect(await authenticateToken(t.raw)).toMatchObject({ agent: "grok", role: "lead" });
    // a role row created for the device is not part of this test; default (no agent_roles row) follows the list
    const { data } = await db().from("agent_roles").select("role").eq("device_id", t.deviceId);
    expect(data ?? []).toEqual([]);

    const asMember = await load(); // grok is not in the default lead list
    expect(asMember.defaultRole("grok")).toBe("member");
    const { authenticateToken: auth2 } = await import("../lib/auth");
    expect(await auth2(t.raw)).toMatchObject({ agent: "grok", role: "member" });
  });
});

describe("lib/config narrowing and validation (unset lists, timezone)", () => {
  it("unset LEAD/RESTRICTED/DEVICE are the built-in defaults narrowed to a custom AGENTS list (no throw)", async () => {
    const c = await load({ AGENCY_BOARD_AGENTS: "claude,hermes,newbot" });
    expect([...c.LEAD_AGENTS]).toEqual(["claude"]);
    expect([...c.RESTRICTED_AGENTS]).toEqual(["hermes"]);
    expect([...c.DEVICE_AGENTS]).toEqual(["claude", "hermes"]);
    expect(["claude", "hermes", "newbot"].map(c.defaultRole)).toEqual(["lead", "member", "member"]);
  });

  it("a custom AGENTS list that shares no id with the defaults yields empty lead/restricted/device sets", async () => {
    const c = await load({ AGENCY_BOARD_AGENTS: "alpha,beta" });
    expect([...c.LEAD_AGENTS, ...c.RESTRICTED_AGENTS, ...c.DEVICE_AGENTS]).toEqual([]);
    expect(c.isRestricted("alpha")).toBe(false);
    expect(c.defaultRole("alpha")).toBe("member");
  });

  it("an explicitly set list must be a subset even when the default would have been narrowed", async () => {
    await expect(load({ AGENCY_BOARD_AGENTS: "alpha,beta", AGENCY_BOARD_LEAD_AGENTS: "claude" })).rejects.toThrow(/not in AGENCY_BOARD_AGENTS/);
  });

  it("AGENCY_BOARD_TIMEZONE must be a valid IANA zone", async () => {
    await expect(load({ AGENCY_BOARD_TIMEZONE: "Mars/Olympus" })).rejects.toThrow(/valid IANA time zone/);
    const c = await load({ AGENCY_BOARD_TIMEZONE: "Asia/Tokyo" });
    expect(c.TIMEZONE).toBe("Asia/Tokyo");
  });
});

describe("token_prefix derivation", () => {
  it.each(["claude", "codex", "hermes", "grok"])("prefix = agency-board_%s_ + 4 random chars", (agent) => {
    const t = newAgentToken(agent);
    const head = `agency-board_${agent}_`;
    expect(tokenPrefixLength(agent)).toBe(head.length + 4);
    expect(t.raw.startsWith(head)).toBe(true);
    expect(t.prefix).toBe(t.raw.slice(0, head.length + 4));
    expect(t.prefix).toHaveLength(head.length + 4);
    expect(t.raw).toHaveLength(head.length + 43);
    expect(t.hash).toBe(sha256hex(t.raw));
  });

  it("the prefix length differs per agent id (not a fixed width)", () => {
    expect(tokenPrefixLength("grok")).toBeLessThan(tokenPrefixLength("claude"));
    // "<TOKEN_PREFIX>_claude_" plus 4 random chars; derived so scripts/rename.sh keeps this test valid
    expect(tokenPrefixLength("claude")).toBe(`${TOKEN_PREFIX}_claude_`.length + 4);
  });

  it("a minted token stores the derived prefix", async () => {
    const m = await mintToken("codex", { machine: "pfx" });
    const { data } = await db().from("agent_tokens").select("token_prefix").eq("id", m.tokenId).single();
    expect(data?.token_prefix).toBe(m.raw.slice(0, tokenPrefixLength("codex")));
  });
});
