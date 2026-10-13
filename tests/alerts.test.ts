import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../lib/db";
import { evaluateAlerts, evaluateAuthBurst, logAndEvaluate, trustAlert } from "../lib/access";
import type { AgentCtx, RequestMeta } from "../lib/types";
import { mintToken, ctxFor, cleanup } from "./helpers";

const dir = fileURLToPath(new URL("./fixtures/alerts", import.meta.url));
const load = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const hit = (h: any) => ({ at: new Date(h.at), network: h.network ?? null, country: h.country ?? null });
const byRule = (a: { rule: string }, b: { rule: string }) => a.rule.localeCompare(b.rule);

describe("evaluateAlerts fixtures (pure)", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "auth-burst.json");
  it.each(files)("%s", (f) => {
    const fx = load(f);
    const known = { countries: new Set<string>(fx.known.countries), networks: new Set<string>(fx.known.networks) };
    const got = evaluateAlerts(hit(fx.cur), known, fx.recent.map(hit))
      .map(({ rule, severity, value }) => ({ rule, severity, value }))
      .sort(byRule);
    expect(got).toEqual([...fx.expect].sort(byRule));
  });
});

describe("evaluateAuthBurst fixtures (pure)", () => {
  it.each(load("auth-burst.json") as any[])("$name", (fx) => {
    const got = evaluateAuthBurst(fx.global, fx.ipFailures, fx.ip);
    if (fx.expect === null) expect(got).toBeNull();
    else expect(got).toMatchObject(fx.expect);
  });
});

describe("logAndEvaluate (integration)", () => {
  let ctx: AgentCtx, tokenId: string, deviceId: string;

  beforeAll(async () => {
    const t = await mintToken("claude");
    tokenId = t.tokenId; deviceId = t.deviceId;
    ctx = await ctxFor(t.raw);
    const { error } = await db().from("device_known").insert([
      { device_id: deviceId, kind: "country", value: "VN", trusted_by: "test" },
      { device_id: deviceId, kind: "network", value: "asn:64500", trusted_by: "test" },
    ]);
    if (error) throw error;
  });
  afterAll(cleanup);

  const meta = (): RequestMeta => ({ ip: "203.0.113.5", country: "JP", city: null, asn: 64500,
    network: "asn:64500", client: "vitest", at: new Date() });
  const openAlerts = async () =>
    (await db().from("alerts").select("*").eq("token_id", tokenId).eq("status", "open")).data ?? [];

  it("new country -> one open alert, no duplicate on repeat, none after trust", async () => {
    await logAndEvaluate(meta(), ctx, "test", 200);
    let open = await openAlerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ rule: "new_country", severity: "red", value: "JP" });

    await logAndEvaluate(meta(), ctx, "test", 200);
    expect(await openAlerts()).toHaveLength(1);

    await trustAlert(open[0].id);
    const { data: known } = await db().from("device_known").select("value").eq("device_id", deviceId).eq("kind", "country");
    expect((known ?? []).map((k: any) => k.value)).toContain("JP");

    await logAndEvaluate(meta(), ctx, "test", 200);
    open = await openAlerts();
    expect(open).toHaveLength(0);
  });
});
