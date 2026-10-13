import { describe, expect, it } from "vitest";
import {
  agentAllowedOnOs,
  agentsForOs,
  alertRuleText,
  alertSentence,
  baseUrlFrom,
  describeNetwork,
  directorToDemote,
  identLabel,
  needsRestrictedWarning,
  type RoleHolder,
} from "../lib/dash/devices";

// Pure helpers only: no DB.

describe("alert wording", () => {
  it("new country names the country", () => {
    expect(alertRuleText("new_country", "SG")).toBe("used from a new country (SG)");
    expect(alertSentence("new_country", "SG", "codex@win-laptop")).toBe("codex@win-laptop used from a new country (SG)");
  });
  it("concurrent use lists the networks readably", () => {
    expect(alertRuleText("concurrent_use", "asn:13335,net:1.2.3.0/24")).toBe("alternating between networks (AS13335, 1.2.3.0/24)");
  });
  it("new network", () => {
    expect(alertRuleText("new_network", "asn:7552")).toBe("used from a new network (AS7552)");
  });
  it("auth burst has no subject and is capitalised", () => {
    expect(alertSentence("auth_burst", "203.0.113.9", "ignored")).toBe("Burst of failed sign-ins from 203.0.113.9");
    expect(alertSentence("auth_burst", "global", null)).toBe("Burst of failed sign-ins across all addresses");
  });
  it("no subject capitalises the rule", () => {
    expect(alertSentence("new_network", "net:10.0.0.0/24", null)).toBe("Used from a new network (10.0.0.0/24)");
  });
  it("unknown rule does not crash", () => {
    expect(alertRuleText("weird", "x")).toBe("unrecognised alert (weird)");
  });
  it("describeNetwork passes unknown shapes through", () => {
    expect(describeNetwork("something")).toBe("something");
  });
});

describe("director demotion", () => {
  const ids: RoleHolder[] = [
    { agent: "claude", device_id: "d1", machine: "laptop", role: "director" },
    { agent: "codex", device_id: "d1", machine: "laptop", role: "lead" },
    { agent: "hermes", device_id: "d1", machine: "laptop", role: "member" },
  ];
  it("names the current director when someone else is promoted", () => {
    const d = directorToDemote(ids, { agent: "codex", device_id: "d1" });
    expect(d && identLabel(d)).toBe("claude@laptop");
  });
  it("null when the target already is director", () => {
    expect(directorToDemote(ids, { agent: "claude", device_id: "d1" })).toBeNull();
  });
  it("null when there is no director", () => {
    expect(directorToDemote(ids.slice(1), { agent: "codex", device_id: "d1" })).toBeNull();
  });
  it("same agent on another device is a different identity", () => {
    const d = directorToDemote(ids, { agent: "claude", device_id: "d2" });
    expect(d?.device_id).toBe("d1");
  });
});

describe("hermes rules", () => {
  it("hermes is not offered on windows", () => {
    expect(agentAllowedOnOs("hermes", "windows")).toBe(false);
    expect(agentAllowedOnOs("hermes", "mac")).toBe(true);
    expect(agentAllowedOnOs("hermes", "linux")).toBe(true);
    expect(agentAllowedOnOs("claude", "windows")).toBe(true);
    expect(agentsForOs(["claude", "hermes", "codex", "claude"], "windows")).toEqual(["claude", "codex"]);
  });
  it("warning only when hermes is promoted to lead or director", () => {
    expect(needsRestrictedWarning("hermes", "member", "lead")).toBe(true);
    expect(needsRestrictedWarning("hermes", "member", "director")).toBe(true);
    expect(needsRestrictedWarning("hermes", "lead", "director")).toBe(true);
    expect(needsRestrictedWarning("hermes", "director", "lead")).toBe(false);
    expect(needsRestrictedWarning("hermes", "lead", "member")).toBe(false);
    expect(needsRestrictedWarning("claude", "member", "director")).toBe(false);
  });
});

describe("baseUrlFrom", () => {
  const h = (m: Record<string, string>) => ({ get: (k: string) => m[k] ?? null });
  it("prefers AGENCY_BOARD_BASE_URL, trims trailing slash", () => {
    expect(baseUrlFrom("https://am.example.com/", h({ host: "x" }))).toBe("https://am.example.com");
  });
  it("uses forwarded host + proto", () => {
    expect(baseUrlFrom(undefined, h({ "x-forwarded-host": "board.example.com", "x-forwarded-proto": "https" }))).toBe("https://board.example.com");
  });
  it("localhost defaults to http", () => {
    expect(baseUrlFrom("", h({ host: "localhost:13104" }))).toBe("http://localhost:13104");
  });
});
