// B-ACCESS pure helpers (lib/dash/access.ts): typed confirmations, matrix model, server-side input validation.
import { describe, it, expect } from "vitest";
import {
  actionErrorMessage,
  buildMatrix,
  confirmMatches,
  createProjectSchema,
  flagConfirmOk,
  flagConfirmWord,
  flagInputSchema,
  formFields,
  grantInputSchema,
  grantNeedsRestrictedAck,
  grantStatusMessage,
  RESTRICTED_WARNING,
  identLabel,
  parseWith,
  renameProjectSchema,
  revokeConfirmOk,
  revokeInputSchema,
  toAuditView,
  type IdentityLike,
} from "../lib/dash/access";
import { TIER_MESSAGES } from "../lib/guard";
import { ApiError } from "../lib/types";

const DEV1 = "11111111-2222-4333-8444-555555555555";
const DEV2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("typed confirmations (kill switch)", () => {
  it("words per flag and direction", () => {
    expect(flagConfirmWord("dispatch", true)).toBe("PAUSE");
    expect(flagConfirmWord("dispatch", false)).toBe("RESUME");
    expect(flagConfirmWord("writes", true)).toBe("FREEZE");
    expect(flagConfirmWord("writes", false)).toBe("UNFREEZE");
  });

  it("exact, case-sensitive; surrounding whitespace forgiven", () => {
    expect(flagConfirmOk("dispatch", true, "PAUSE")).toBe(true);
    expect(flagConfirmOk("dispatch", true, "  PAUSE ")).toBe(true);
    expect(flagConfirmOk("dispatch", true, "pause")).toBe(false);
    expect(flagConfirmOk("dispatch", true, "RESUME")).toBe(false); // wrong direction
    expect(flagConfirmOk("writes", false, "UNFREEZE")).toBe(true);
    expect(flagConfirmOk("writes", false, "FREEZE")).toBe(false);
    expect(flagConfirmOk("writes", true, "FREEZ")).toBe(false);
    expect(flagConfirmOk("writes", true, "P A U S E")).toBe(false);
  });

  it("non-strings and empty expectations never match", () => {
    expect(confirmMatches("PAUSE", undefined)).toBe(false);
    expect(confirmMatches("PAUSE", null)).toBe(false);
    expect(confirmMatches("PAUSE", 1)).toBe(false);
    expect(confirmMatches("", "")).toBe(false);
  });

  it("revoke needs the agent name exactly", () => {
    expect(revokeConfirmOk("hermes", "hermes")).toBe(true);
    expect(revokeConfirmOk("hermes", "Hermes")).toBe(false);
    expect(revokeConfirmOk("hermes", "codex")).toBe(false);
    expect(revokeConfirmOk("hermes", "")).toBe(false);
  });
});

describe("matrix model", () => {
  const ids: IdentityLike[] = [
    { agent: "hermes", device_id: DEV1, machine: "laptop", role: "member", grants: [], revoked: false },
    { agent: "claude", device_id: DEV1, machine: "laptop", role: "director", grants: ["confidential"], revoked: false },
    { agent: "codex", device_id: DEV2, machine: "win-desk", role: "lead", grants: ["alpha", "gone"], revoked: true },
    { agent: "codex", device_id: DEV1, machine: "laptop", role: "lead", grants: [], revoked: false },
  ];
  const projects = [
    { slug: "confidential", name: "Confidential", grant_count: 1 },
    { slug: "alpha", name: "Alpha", grant_count: 1 },
  ];

  it("columns sorted by slug, with name and grant count", () => {
    const m = buildMatrix(ids, projects);
    expect(m.columns).toEqual([
      { slug: "alpha", name: "Alpha", grantCount: 1 },
      { slug: "confidential", name: "Confidential", grantCount: 1 },
    ]);
  });

  it("rows: active first, then role, then ident; revoked last", () => {
    const m = buildMatrix(ids, projects);
    expect(m.rows.map((r) => r.ident)).toEqual(["claude@laptop", "codex@laptop", "hermes@laptop", "codex@win-desk"]);
    expect(m.rows[3].revoked).toBe(true);
    expect(m.rows.find((r) => r.agent === "hermes")?.isRestricted).toBe(true);
    expect(m.rows.filter((r) => r.isRestricted)).toHaveLength(1);
  });

  it("a cell is checked iff the slug is in the identity's grants (all off by default)", () => {
    const m = buildMatrix(ids, projects);
    const cell = (ident: string, slug: string) => m.rows.find((r) => r.ident === ident)!.cells.find((c) => c.slug === slug)!.checked;
    expect(cell("claude@laptop", "confidential")).toBe(true);
    expect(cell("claude@laptop", "alpha")).toBe(false);
    expect(cell("hermes@laptop", "confidential")).toBe(false);
    expect(cell("codex@win-desk", "alpha")).toBe(true);
    // unknown granted slug ("gone") does not create a column
    expect(m.rows[3].cells.map((c) => c.slug)).toEqual(["alpha", "confidential"]);
    // every row has one cell per column, keys unique
    const keys = m.rows.flatMap((r) => r.cells.map((c) => c.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of m.rows) expect(r.cells).toHaveLength(2);
  });

  it("empty inputs", () => {
    expect(buildMatrix([], projects)).toEqual({ columns: projects.map((p) => ({ slug: p.slug, name: p.name, grantCount: 1 })).sort((a, b) => a.slug.localeCompare(b.slug)), rows: [] });
    const noProj = buildMatrix(ids, []);
    expect(noProj.columns).toEqual([]);
    expect(noProj.rows.every((r) => r.cells.length === 0)).toBe(true);
  });

  it("drops rows with an unknown agent or role (defensive)", () => {
    const bad = [{ ...ids[0], agent: "gpt" as never }, { ...ids[1], role: "admin" as never }];
    expect(buildMatrix(bad, projects).rows).toEqual([]);
  });

  it("ident label and status message", () => {
    expect(identLabel("codex", "laptop")).toBe("codex@laptop");
    expect(identLabel("codex", "")).toBe("codex");
    expect(grantStatusMessage(true, "confidential", "codex@laptop")).toBe("Granted confidential to codex@laptop");
    expect(grantStatusMessage(false, "confidential", "codex@laptop")).toBe("Removed confidential from codex@laptop");
  });

  it("restricted warning text is exact", () => {
    expect(RESTRICTED_WARNING).toBe("A restricted agent stays read/write capped at every role. Granting it a confidential project or a higher role needs explicit confirmation.");
  });
});

describe("server-side input validation", () => {
  const good = { agent: "codex", device_id: DEV1, slug: "confidential", granted: true };

  it("grant: accepts a valid input, lowercases the uuid", () => {
    const p = parseWith(grantInputSchema, { ...good, device_id: DEV1.toUpperCase() });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value).toEqual({ ...good, device_id: DEV1 });
  });

  it("grant: rejects unknown agent, bad uuid, bad slug, non-boolean granted", () => {
    expect(parseWith(grantInputSchema, { ...good, agent: "gpt" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, agent: "Codex" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, device_id: "not-a-uuid" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, device_id: `${DEV1}x` }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, slug: "Sea Bank" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, slug: "a".repeat(41) }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, slug: "" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, granted: "true" }).ok).toBe(false);
    expect(parseWith(grantInputSchema, { ...good, granted: undefined }).ok).toBe(false);
    expect(parseWith(grantInputSchema, null).ok).toBe(false);
  });

  it("grant: a restricted-agent grant needs the dialog ack; ungrant and other agents do not", () => {
    expect(grantNeedsRestrictedAck({ agent: "hermes", granted: true })).toBe(true);
    expect(grantNeedsRestrictedAck({ agent: "hermes", granted: true, restricted_ack: false })).toBe(true);
    expect(grantNeedsRestrictedAck({ agent: "hermes", granted: true, restricted_ack: true })).toBe(false);
    expect(grantNeedsRestrictedAck({ agent: "hermes", granted: false })).toBe(false);
    expect(grantNeedsRestrictedAck({ agent: "codex", granted: true })).toBe(false);
  });

  it("project create / rename: slug regex and name 1-80 (trimmed)", () => {
    expect(parseWith(createProjectSchema, { slug: "acme-bank", name: "  Acme Bank " })).toEqual({ ok: true, value: { slug: "acme-bank", name: "Acme Bank" } });
    expect(parseWith(createProjectSchema, { slug: "acme_bank", name: "Acme" }).ok).toBe(false);
    expect(parseWith(createProjectSchema, { slug: "ACME", name: "Acme" }).ok).toBe(false);
    expect(parseWith(createProjectSchema, { slug: "acme", name: "   " }).ok).toBe(false);
    expect(parseWith(createProjectSchema, { slug: "acme", name: "x".repeat(81) }).ok).toBe(false);
    expect(parseWith(createProjectSchema, { slug: "acme", name: "x".repeat(80) }).ok).toBe(true);
    expect(parseWith(renameProjectSchema, { slug: "confidential", name: "Confidential contracts" }).ok).toBe(true);
    expect(parseWith(renameProjectSchema, { slug: "../confidential", name: "x" }).ok).toBe(false);
  });

  it("flag + revoke inputs from FormData", () => {
    const fd = new FormData();
    fd.set("flag", "dispatch");
    fd.set("on", "true");
    fd.set("confirm", "PAUSE");
    const p = parseWith(flagInputSchema, formFields(fd));
    expect(p).toEqual({ ok: true, value: { flag: "dispatch", on: true, confirm: "PAUSE" } });
    expect(parseWith(flagInputSchema, { flag: "everything", on: "true", confirm: "" }).ok).toBe(false);
    expect(parseWith(flagInputSchema, { flag: "writes", on: "yes", confirm: "" }).ok).toBe(false);
    expect(parseWith(flagInputSchema, { flag: "writes", on: "false" }).ok).toBe(false); // confirm required
    expect(parseWith(revokeInputSchema, { agent: "grok", confirm: "grok" }).ok).toBe(true);
    expect(parseWith(revokeInputSchema, { agent: "*", confirm: "*" }).ok).toBe(false);
  });

  it("parse errors name the field and never echo the value", () => {
    const p = parseWith(grantInputSchema, { ...good, slug: "SECRET-VALUE" });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error.startsWith("slug: ")).toBe(true);
      expect(p.error).not.toContain("SECRET-VALUE");
    }
  });
});

describe("audit view + error mapping", () => {
  it("shapes audit rows defensively", () => {
    const v = toAuditView([
      { id: 7, at: "2026-10-07T01:00:00Z", actor: "owner", action: "grant", target: "codex@laptop", detail: { project: "confidential" } },
      { id: 6, at: null, action: "role_set", target: "claude@laptop", detail: { from: "lead", to: "director", demoted: null } },
      null,
      "junk",
    ]);
    expect(v).toEqual([
      { id: "7", at: "2026-10-07T01:00:00Z", actor: "owner", action: "grant", target: "codex@laptop", detail: "project: confidential" },
      { id: "6", at: null, actor: "owner", action: "role_set", target: "claude@laptop", detail: "from: lead, to: director" },
    ]);
  });

  it("maps errors to short messages", () => {
    expect(actionErrorMessage({ status: 409, code: "CONFLICT" }).message).toMatch(/already exists/);
    expect(actionErrorMessage({ status: 404, code: "NOT_FOUND" }).status).toBe(404);
    expect(actionErrorMessage({ code: "PGRST205" }).message).toMatch(/20261007000002/);
    expect(actionErrorMessage(new Error("boom with secret")).message).not.toContain("secret");
    expect(actionErrorMessage(undefined).status).toBe(500);
  });

  // §13.5 classes 3-5 (e.g. a confidential project name): readable 422 from ApiError and from the DB trigger.
  it.each([
    ["EMPLOYEE_PII_BLOCKED", "staff_id", /employee personal information/i],
    ["FINANCIALS_BLOCKED", "budget_amount", /non-public financial/i],
    ["CREDENTIALS_BLOCKED", "password", /credentials/i],
  ] as const)("maps %s to a readable 422 (ApiError and DB trigger)", (code, rule, re) => {
    for (const e of [new ApiError(422, code, TIER_MESSAGES[code], { rule }), { code: "P0001", message: `${code}:${rule}` }]) {
      const r = actionErrorMessage(e);
      expect(r.status).toBe(422);
      expect(r.message).toMatch(re);
    }
  });
});
