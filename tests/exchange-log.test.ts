import { describe, it, expect, afterAll } from "vitest";
import { db } from "../lib/db";
import { logAndEvaluate } from "../lib/access";
import { issueConnectCode } from "../lib/devices";
import { POST as exchangePOST } from "../app/api/connect/exchange/route";
import type { RequestMeta } from "../lib/types";
import { machineName, mintToken, ctxFor, cleanup } from "./helpers";

const base = (process.env.AGENCY_BOARD_BASE_URL || "http://localhost:13100").replace(/\/+$/, "");
const ROUTE = "connect:exchange";
const ips: string[] = [];
const newIp = () => {
  let ip: string;
  do ip = `192.0.2.${Math.floor(Math.random() * 250) + 1}`; while (ips.includes(ip));
  ips.push(ip);
  return ip;
};
const post = (body: unknown, ip: string) =>
  exchangePOST(new Request(`${base}/api/connect/exchange`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": ip, "x-vercel-ip-country": "VN", "x-vercel-ip-as-number": "64501" },
  }));

// The route logs after the response (fire-and-forget outside a Next request scope), so poll for the rows.
async function rowsFor(ip: string, want: number): Promise<any[]> {
  let rows: any[] = [];
  for (let i = 0; i < 50; i++) {
    const { data, error } = await db().from("access_log").select("*").eq("route", ROUTE).eq("ip", ip).order("id");
    if (error) throw error;
    rows = data ?? [];
    if (rows.length >= want) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return rows;
}

afterAll(async () => {
  if (ips.length) await db().from("access_log").delete().eq("route", ROUTE).in("ip", ips);
  await cleanup();
});

describe("connect:exchange access_log rows", () => {
  it("success: one row per issued token with token id, device id and agent; never the token value or the code", async () => {
    const ip = newIp();
    const issued = await issueConnectCode({ machineName: machineName("xlog"), agents: ["claude", "codex"] }, base);
    const r = await post({ code: issued.code }, ip);
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as any;

    const rows = await rowsFor(ip, 2);
    expect(rows).toHaveLength(2);
    const { data: toks } = await db().from("agent_tokens").select("id, agent, device_id").eq("device_id", data.device_id);
    const byAgent = new Map((toks ?? []).map((t: any) => [t.agent, t.id]));
    expect(rows.map((x) => x.agent).sort()).toEqual(["claude", "codex"]);
    for (const row of rows) {
      expect(row).toMatchObject({ route: ROUTE, result: 200, device_id: data.device_id, token_id: byAgent.get(row.agent) });
    }

    // Secret hygiene: nothing in the persisted row may contain a raw token or the connect code.
    const dump = JSON.stringify(rows);
    for (const raw of Object.values(data.tokens) as string[]) expect(dump.includes(raw)).toBe(false);
    expect(dump.includes(issued.code)).toBe(false);
    expect(dump.toLowerCase().includes(issued.code.toLowerCase())).toBe(false);
  });

  it("success row is not a token use and raises no alert", async () => {
    const ip = newIp();
    const issued = await issueConnectCode({ machineName: machineName("xnoalert"), agents: ["claude"] }, base);
    const r = await post({ code: issued.code }, ip);
    expect(r.status).toBe(200);
    const { data } = (await r.json()) as any;
    await rowsFor(ip, 1);
    const { data: tok } = await db().from("agent_tokens").select("id, last_used_at").eq("device_id", data.device_id).single();
    expect(tok!.last_used_at).toBeNull();
    const { data: alerts } = await db().from("alerts").select("id").eq("device_id", data.device_id);
    expect(alerts).toEqual([]);
  });

  it("failure rows are unchanged: no token, device or agent", async () => {
    const ip = newIp();
    const r = await post({ code: "garbage!" }, ip);
    expect(r.status).toBe(400);
    const rows = await rowsFor(ip, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: ROUTE, result: 400, token_id: null, device_id: null, agent: null });
    expect(JSON.stringify(rows)).not.toContain("garbage");
  });

  it("a used code fails with a null-identity row", async () => {
    const ip = newIp();
    const issued = await issueConnectCode({ machineName: machineName("xused"), agents: ["claude"] }, base);
    expect((await post({ code: issued.code }, ip)).status).toBe(200);
    await rowsFor(ip, 1);
    const ip2 = newIp();
    expect((await post({ code: issued.code }, ip2)).status).toBe(410);
    const rows = await rowsFor(ip2, 1);
    expect(rows[0]).toMatchObject({ result: 410, token_id: null, device_id: null, agent: null });
  });
});

describe("exchange row vs alert rules", () => {
  it("an exchange row does not make A (connect) -> B -> A look like concurrent_use", async () => {
    const t = await mintToken("claude");
    const ctx = await ctxFor(t.raw);
    await db().from("device_known").insert([
      { device_id: t.deviceId, kind: "country", value: "VN", trusted_by: "test" },
      { device_id: t.deviceId, kind: "network", value: "asn:64500", trusted_by: "test" },
      { device_id: t.deviceId, kind: "network", value: "asn:64501", trusted_by: "test" },
    ]);
    const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000);
    const m = (asn: number, minAgo: number): RequestMeta => ({ ip: "203.0.113.7", country: "VN", city: null, asn,
      network: `asn:${asn}`, client: "vitest", at: at(minAgo) });
    // the exchange row, as the route writes it: connect network A
    const { error } = await db().from("access_log").insert({ at: at(3).toISOString(), token_id: t.tokenId, device_id: t.deviceId,
      agent: "claude", ip: "203.0.113.7", asn: 64500, country: "VN", client: "vitest", route: ROUTE, result: 200 });
    if (error) throw error;
    await logAndEvaluate(m(64501, 2), ctx, "test", 200); // first real use from B
    await logAndEvaluate(m(64500, 0), ctx, "test", 200); // back on A
    const { data: alerts } = await db().from("alerts").select("rule").eq("token_id", t.tokenId);
    expect(alerts).toEqual([]);
  });
});
