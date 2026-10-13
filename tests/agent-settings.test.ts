// Listen/wait interval setting (migration 20261013000007_agent_settings.sql, lib/agentSettings.ts).
// DB-backed parts need 0007 applied on the target project; run against the LOCAL stack only (see .env.example).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { db } from "../lib/db";
import { setFlags } from "../lib/flags";
import {
  LISTEN_MIN, LISTEN_MAX, LISTEN_DEFAULT, parseListenMinutes, getListenMinutes, setListenMinutes, listListenMinutes,
} from "../lib/agentSettings";
import { listTasks, heartbeat, inbox, inboxText } from "../lib/handlers";
import type { AgentCtx } from "../lib/types";
import { mintToken, ctxFor, cleanup, apiErr } from "./helpers";

describe("parseListenMinutes (pure)", () => {
  it("constants: 0..60, default 30", () => {
    expect([LISTEN_MIN, LISTEN_MAX, LISTEN_DEFAULT]).toEqual([0, 60, 30]);
  });
  it("accepts integers 0..60 as number or digit string", () => {
    for (const v of [0, 1, 5, 30, 59, 60]) expect(parseListenMinutes(v)).toBe(v);
    expect(parseListenMinutes("0")).toBe(0);
    expect(parseListenMinutes("45")).toBe(45);
    expect(parseListenMinutes("60")).toBe(60);
  });
  it("rejects out of range, fractional, non-numeric and non-scalar input", () => {
    for (const v of [61, -1, 1.5, NaN, Infinity, "abc", "", " 5", "5 ", "1.5", "-1", "61", "1e1", null, undefined, true, {}, [], [5]])
      expect(parseListenMinutes(v), String(v)).toBeNull();
  });
});

let a: AgentCtx, b: AgentCtx, c: AgentCtx, hb: AgentCtx, hb2: AgentCtx;
let aDev: string, bDev: string, cDev: string, hbDev: string;
let cRaw: string;

beforeAll(async () => {
  const ta = await mintToken("claude", { machine: "s1" });
  const tb = await mintToken("codex", { machine: "s2" });
  const tc = await mintToken("claude", { machine: "s3" });
  a = await ctxFor(ta.raw); b = await ctxFor(tb.raw); c = await ctxFor(tc.raw);
  aDev = ta.deviceId; bDev = tb.deviceId; cDev = tc.deviceId; cRaw = tc.raw;
  // heartbeat is rate limited to 2/min per token: one token for the two reads, one for the failing-read check
  const th = await mintToken("claude", { machine: "s5" });
  hb = await ctxFor(th.raw); hbDev = th.deviceId; hb2 = await ctxFor((await mintToken("claude", { machine: "s6" })).raw);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await setFlags({ dispatchPaused: false, writesFrozen: false });
  await cleanup();
});

describe("get/set/list against the DB", () => {
  it("get falls back to 30 when there is no row, and for a null device", async () => {
    expect(await getListenMinutes("claude", aDev)).toBe(30);
    expect(await getListenMinutes("claude", null)).toBe(30);
  });
  it("set stores 0 and 60 and get reads them back", async () => {
    expect(await setListenMinutes("claude", aDev, 0)).toBe(0);
    expect(await getListenMinutes("claude", aDev)).toBe(0);
    expect(await setListenMinutes("claude", aDev, 60)).toBe(60);
    expect(await getListenMinutes("claude", aDev)).toBe(60);
    expect(await setListenMinutes("claude", aDev, "15" as unknown as number)).toBe(15);
  });
  it("set rejects 61, -1, 1.5, 'abc' with a 422 VALIDATION and leaves the stored value alone", async () => {
    await setListenMinutes("claude", aDev, 20);
    for (const bad of [61, -1, 1.5, "abc"]) {
      const e = await apiErr(setListenMinutes("claude", aDev, bad as unknown as number));
      expect(e).toMatchObject({ status: 422, code: "VALIDATION" });
    }
    expect(await getListenMinutes("claude", aDev)).toBe(20);
  });
  it("set rejects an unknown agent", async () => {
    expect(await apiErr(setListenMinutes("bogus" as any, aDev, 5))).toMatchObject({ status: 422, code: "VALIDATION" });
  });
  it("upsert is idempotent: same value twice and a change keep exactly one row", async () => {
    await setListenMinutes("codex", bDev, 10);
    await setListenMinutes("codex", bDev, 10);
    await setListenMinutes("codex", bDev, 25);
    const { data } = await db().from("agent_settings").select("listen_minutes").eq("agent", "codex").eq("device_id", bDev);
    expect(data).toEqual([{ listen_minutes: 25 }]);
  });
  it("is keyed per agent AND device", async () => {
    await setListenMinutes("claude", cDev, 7);
    expect(await getListenMinutes("claude", cDev)).toBe(7);
    expect(await getListenMinutes("codex", cDev)).toBe(30);
    expect(await getListenMinutes("claude", bDev)).toBe(30);
  });
  it("list returns only existing rows keyed agent:device and tolerates []", async () => {
    await setListenMinutes("claude", aDev, 12);
    await setListenMinutes("codex", bDev, 25);
    await setListenMinutes("claude", cDev, 7);
    const m = await listListenMinutes([aDev, bDev, cDev, "00000000-0000-0000-0000-000000000000"]);
    expect(m.get(`claude:${aDev}`)).toBe(12);
    expect(m.get(`codex:${bDev}`)).toBe(25);
    expect(m.get(`claude:${cDev}`)).toBe(7);
    expect(m.size).toBe(3);
    expect((await listListenMinutes([])).size).toBe(0);
  });
  it("rows go away with their device (on delete cascade)", async () => {
    const t = await mintToken("claude", { machine: "s4" });
    await setListenMinutes("claude", t.deviceId, 9);
    await db().from("agent_tokens").delete().eq("id", t.tokenId);
    const { error } = await db().from("devices").delete().eq("id", t.deviceId);
    expect(error).toBeNull();
    const { data } = await db().from("agent_settings").select("device_id").eq("device_id", t.deviceId);
    expect(data).toEqual([]);
  });
  it("DB check rejects an out-of-range value written around the library", async () => {
    const { error } = await db().from("agent_settings").insert({ agent: "claude", device_id: aDev, listen_minutes: 61 });
    expect(error).not.toBeNull();
  });
});

describe("readers never throw (table missing or any DB error means 30)", () => {
  it("getListenMinutes and listListenMinutes swallow a failing db call", async () => {
    await setListenMinutes("claude", aDev, 5);
    vi.spyOn(db(), "from").mockImplementation((() => { throw new Error("boom"); }) as any);
    expect(await getListenMinutes("claude", aDev)).toBe(30);
    expect((await listListenMinutes([aDev])).size).toBe(0);
  });
  it("swallows a PostgREST error result (e.g. relation does not exist)", async () => {
    const q: any = { select: () => q, eq: () => q, in: () => q, maybeSingle: async () => ({ data: null, error: { code: "42P01", message: "relation does not exist" } }), then: (f: any) => f({ data: null, error: { code: "42P01", message: "relation does not exist" } }) };
    vi.spyOn(db(), "from").mockImplementation((() => q) as any);
    expect(await getListenMinutes("claude", aDev)).toBe(30);
    expect((await listListenMinutes([aDev])).size).toBe(0);
  });
  it("setListenMinutes throws on a DB error (writers are loud)", async () => {
    vi.spyOn(db(), "from").mockImplementation((() => { throw new Error("boom"); }) as any);
    await expect(setListenMinutes("claude", aDev, 5)).rejects.toThrow();
  });
});

describe("handlers carry listen_minutes", () => {
  it("list_tasks mine=true carries it and follows a changed row; without mine it is absent", async () => {
    await db().from("agent_settings").delete().eq("device_id", cDev);
    expect((await listTasks(c, { mine: true }) as any).listen_minutes).toBe(30);
    await setListenMinutes("claude", cDev, 0);
    expect((await listTasks(c, { mine: true }) as any).listen_minutes).toBe(0);
    await setListenMinutes("claude", cDev, 42);
    expect((await listTasks(c, { mine: true }) as any).listen_minutes).toBe(42);
    expect("listen_minutes" in (await listTasks(c, {}) as any)).toBe(false);
  });
  it("list_tasks on the dispatch-paused path keeps its exact shape", async () => {
    await setFlags({ dispatchPaused: true });
    try {
      expect(await listTasks(await ctxFor(cRaw), { mine: true })).toEqual({ tasks: [], dispatch_paused: true });
    } finally { await setFlags({ dispatchPaused: false }); }
  });
  it("inbox JSON carries it, reflects a changed row, and inboxText is unchanged by it", async () => {
    await setListenMinutes("codex", bDev, 17);
    const r: any = await inbox(b, {});
    expect(r.listen_minutes).toBe(17);
    await setListenMinutes("codex", bDev, 3);
    expect(((await inbox(b, {})) as any).listen_minutes).toBe(3);
    const text = inboxText(r);
    expect(text).toBe(inboxText({ ...r, listen_minutes: undefined }));
    expect(text).not.toMatch(/listen/i);
  });
  it("heartbeat carries it and reflects a changed row", async () => {
    await setListenMinutes("claude", hbDev, 11);
    expect(((await heartbeat(hb, {})) as any).listen_minutes).toBe(11);
    await setListenMinutes("claude", hbDev, 0);
    const h: any = await heartbeat(hb, {});
    expect(h).toMatchObject({ ok: true, lease_renewed: false });
    expect(h.listen_minutes).toBe(0);
  });
  it("handlers still answer with 30 when the settings read fails", async () => {
    const real = db().from.bind(db());
    vi.spyOn(db(), "from").mockImplementation(((t: string) => { if (t === "agent_settings") throw new Error("boom"); return real(t); }) as any);
    expect(((await heartbeat(hb2, {})) as any).listen_minutes).toBe(30);
    expect(((await inbox(a, {})) as any).listen_minutes).toBe(30);
    expect(((await listTasks(a, { mine: true })) as any).listen_minutes).toBe(30);
  });
});
