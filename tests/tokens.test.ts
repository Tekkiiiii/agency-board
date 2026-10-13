import { describe, it, expect, afterAll } from "vitest";
import { db } from "../lib/db";
import { sha256hex, authenticateTokenDetailed } from "../lib/auth";
import { issueConnectCode, exchangeCode, rotateDevice, revokeAgent } from "../lib/devices";
import { withAgent, withAdmin, json } from "../lib/request";
import { POST as exchangePOST } from "../app/api/connect/exchange/route";
import type { RequestMeta } from "../lib/types";
import { runId, machineName, mintToken, cleanup } from "./helpers";

// exchange route prefers AGENCY_BOARD_BASE_URL over the request origin — mirror it so the test is env-independent
const base = (process.env.AGENCY_BOARD_BASE_URL || "http://localhost:13100").replace(/\/+$/, "");
const meta = (): RequestMeta => ({ ip: `198.51.100.${Math.floor(Math.random() * 250) + 1}`, country: "VN",
  city: "Ho Chi Minh City", asn: 64501, network: "asn:64501", client: "vitest", at: new Date() });
const req = (bearer: string) => new Request("http://localhost/x", { headers: { authorization: `Bearer ${bearer}` } });

afterAll(cleanup);

describe("connect codes", () => {

  it("exchange returns tokens for requested agents; tokens authenticate; reuse -> CODE_USED", async () => {
    const issued = await issueConnectCode({ machineName: machineName("conn"), os: "mac", agents: ["claude", "codex"] }, base);
    expect(issued.code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);
    const res: any = await exchangeCode({ code: issued.code }, meta());
    expect(Object.keys(res.tokens).sort()).toEqual(["claude", "codex"]);
    const a: any = await authenticateTokenDetailed(res.tokens.claude);
    expect(a.ctx).toMatchObject({ agent: "claude", machine: machineName("conn"), deviceId: res.deviceId });
    // MVP-b0 §11: exchange seeds a default agent_roles row per agent (on conflict do nothing); scopes come from the role.
    expect(a.ctx).toMatchObject({ role: "lead", ident: `claude@${machineName("conn")}`, readNs: ["*"], writeNs: ["*"] });
    const { data: roles } = await db().from("agent_roles").select("agent, role").eq("device_id", res.deviceId).order("agent");
    expect(roles).toEqual([{ agent: "claude", role: "lead" }, { agent: "codex", role: "lead" }]);

    await expect(exchangeCode({ code: issued.code }, meta())).rejects.toMatchObject({ status: 410, code: "CODE_USED" });
  });

  it("exchange route adds flat token_<agent> keys + server_url for shell parsing", async () => {
    const issued = await issueConnectCode({ machineName: machineName("route"), agents: ["claude", "codex"] }, base);
    const r = await exchangePOST(new Request(`${base}/api/connect/exchange`, {
      method: "POST", body: JSON.stringify({ code: issued.code }),
      headers: { "content-type": "application/json", "x-forwarded-for": meta().ip! },
    }));
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as any;
    // booleans only, so a failure never prints a raw token
    expect(data.token_claude === data.tokens.claude && typeof data.token_claude === "string").toBe(true);
    expect(data.token_codex === data.tokens.codex && typeof data.token_codex === "string").toBe(true);
    expect("token_hermes" in data).toBe(false);
    expect(data.server_url).toBe(`${base}/api/mcp`);
  });

  it("expired code -> 410 CODE_EXPIRED", async () => {
    const issued = await issueConnectCode({ machineName: machineName("exp"), agents: ["claude"] }, base);
    await db().from("connect_codes").update({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .eq("code_hash", sha256hex(issued.code));
    await expect(exchangeCode({ code: issued.code }, meta())).rejects.toMatchObject({ status: 410, code: "CODE_EXPIRED" });
  });

  it("garbage code -> 400 CODE_INVALID", async () => {
    await expect(exchangeCode({ code: "garbage!" }, meta())).rejects.toMatchObject({ status: 400, code: "CODE_INVALID" });
  });

  it("rotateDevice revokes old tokens and returns a new code", async () => {
    const issued = await issueConnectCode({ machineName: machineName("rot"), agents: ["claude", "codex"] }, base);
    const res: any = await exchangeCode({ code: issued.code }, meta());
    expect(await authenticateTokenDetailed(res.tokens.claude)).toHaveProperty("ctx");
    const r = await rotateDevice(res.deviceId, base);
    expect(r.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.code).not.toBe(issued.code);
    expect(await authenticateTokenDetailed(res.tokens.claude)).toEqual({ error: "REVOKED" });
    expect(await authenticateTokenDetailed(res.tokens.codex)).toEqual({ error: "REVOKED" });
  });
});

describe("revokeAgent", () => {
  it("revokes only that agent's tokens", async (t) => {
    // Live DB: revokeAgent is global. Refuse to run if any real (non-test) codex token is active.
    const { data: live } = await db().from("agent_tokens").select("id, devices!inner(machine_name)")
      .eq("agent", "codex").is("revoked_at", null);
    const real = (live ?? []).filter((r: any) => !String(r.devices?.machine_name ?? "").startsWith("test-"));
    if (real.length) t.skip(`skipped: ${real.length} real codex token(s) active; revokeAgent would revoke them`);

    const claude = await mintToken("claude", { machine: "rv" });
    const codex = await mintToken("codex", { machine: "rv" });
    expect(await revokeAgent("codex")).toBeGreaterThanOrEqual(1);
    expect(await authenticateTokenDetailed(codex.raw)).toEqual({ error: "REVOKED" });
    expect(await authenticateTokenDetailed(claude.raw)).toHaveProperty("ctx");
  });
});

describe("credential separation", () => {
  const body = async (r: Response) => ((await r.json()) as any).error;

  it("withAgent rejects an admin token -> 403 AGENT_ONLY", async () => {
    const r = await withAgent(req(`agency-board-admin_FAKE${runId}`), "test", async () => json({ ok: true }));
    expect(r.status).toBe(403);
    expect((await body(r)).code).toBe("AGENT_ONLY");
  });

  it("withAdmin rejects an agent token -> 403 ADMIN_ONLY", async () => {
    const { raw } = await mintToken("claude", { machine: "sep" });
    const r = await withAdmin(req(raw), "test", async () => json({ ok: true }));
    expect(r.status).toBe(403);
    expect((await body(r)).code).toBe("ADMIN_ONLY");
  });
});
