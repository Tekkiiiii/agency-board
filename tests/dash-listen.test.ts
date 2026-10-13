// Listen/wait slider on /dashboard/devices: data load + server action (Addendum 2: slider 0-60 min, step 1, default 30, 0 = off).
// DB-backed parts need migration 20261013000007 on the target project; run against the LOCAL stack only (localenv.sh).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const requireAdmin = vi.fn(async () => ({ email: "admin@test.invalid" }));
const logAdminAction = vi.fn(async (_name: string, _status: number) => {});
const revalidatePath = vi.fn();
vi.mock("../lib/dash/session", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("../lib/dash/log", () => ({ logAdminAction: (n: string, s: number) => logAdminAction(n, s) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

import { db } from "../lib/db";
import { getListenMinutes, LISTEN_DEFAULT, LISTEN_MAX, LISTEN_MIN } from "../lib/agentSettings";
import { UI_DEFAULT, UI_MAX, UI_MIN } from "../lib/dash/listen";
import { listenKey, loadListenMinutes } from "../lib/dash/devices";
import { setListenMinutesAction } from "../app/dashboard/devices/actions";
import { INITIAL_STATE } from "../app/dashboard/devices/types";
import { mintToken, cleanup } from "./helpers";

let migrated = false;
let devA = "", devB = "";

function form(m: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(m)) fd.set(k, v);
  return fd;
}

beforeAll(async () => {
  const { error } = await db().from("agent_settings").select("agent").limit(1);
  migrated = !error;
  if (!migrated) console.warn("dash-listen.test: migration 20261013000007 not applied; integration cases are skipped");
  devA = (await mintToken("claude", { machine: "lsn-a" })).deviceId;
  devB = (await mintToken("codex", { machine: "lsn-b" })).deviceId;
});
afterAll(cleanup);
beforeEach(() => { requireAdmin.mockClear(); logAdminAction.mockClear(); revalidatePath.mockClear(); });

describe("loadListenMinutes", () => {
  it("empty input -> empty map, no query needed", async () => {
    expect((await loadListenMinutes([])).size).toBe(0);
  });
  it("returns only existing rows for claude/codex identities, keyed agent:device; the default applies for the rest", async (t) => {
    if (!migrated) t.skip("migration not applied");
    await db().from("agent_settings").upsert([
      { agent: "claude", device_id: devA, listen_minutes: 7 },
      { agent: "codex", device_id: devB, listen_minutes: 0 },
      { agent: "hermes", device_id: devB, listen_minutes: 12 },
    ], { onConflict: "agent,device_id" });
    const m = await loadListenMinutes([
      { agent: "claude", device_id: devA }, { agent: "codex", device_id: devB },
      { agent: "claude", device_id: devB }, { agent: "hermes", device_id: devB },
    ]);
    expect(m.get(listenKey("claude", devA))).toBe(7);
    expect(m.get(listenKey("codex", devB))).toBe(0);
    expect(m.has(listenKey("claude", devB))).toBe(false); // no row: caller shows the default 30
    expect(m.has(listenKey("hermes", devB))).toBe(false); // no slider for hermes
  });
  it("never throws when the table is missing or the query fails", async () => {
    const spy = vi.spyOn(db() as any, "from").mockImplementation(() => { throw new Error("relation agent_settings does not exist"); });
    try {
      const m = await loadListenMinutes([{ agent: "claude", device_id: devA }]);
      expect(m.size).toBe(0);
    } finally { spy.mockRestore(); }
  });
});

describe("setListenMinutesAction", () => {
  it("calls requireAdmin first; a rejecting requireAdmin writes nothing", async (t) => {
    if (!migrated) t.skip("migration not applied");
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(setListenMinutesAction(INITIAL_STATE, form({ agent: "claude", device_id: devA, minutes: "11" }))).rejects.toThrow("NEXT_REDIRECT");
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(await getListenMinutes("claude", devA)).not.toBe(11);
  });
  it("saves a valid value, audits 200, revalidates the page", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const r = await setListenMinutesAction(INITIAL_STATE, form({ agent: "claude", device_id: devA, minutes: "15" }));
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(await getListenMinutes("claude", devA)).toBe(15);
    expect(logAdminAction).toHaveBeenCalledWith("listen_minutes_set", 200);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard/devices");
  });
  it("0 (off) is saved", async (t) => {
    if (!migrated) t.skip("migration not applied");
    const r = await setListenMinutesAction(INITIAL_STATE, form({ agent: "codex", device_id: devB, minutes: "0" }));
    expect(r.ok).toBe(true);
    expect(await getListenMinutes("codex", devB)).toBe(0);
  });
  it("rejects invalid input with a fixed message, audits 422, writes nothing, reflects nothing", async () => {
    const bad: Array<Record<string, string>> = [
      { agent: "claude", device_id: devA, minutes: "61" },
      { agent: "claude", device_id: devA, minutes: "<script>x</script>" },
      { agent: "claude", device_id: devA, minutes: "1.5" },
      { agent: "hermes", device_id: devA, minutes: "5" },
      { agent: "claude", device_id: "not-a-uuid<b>", minutes: "5" },
      {},
    ];
    for (const b of bad) {
      logAdminAction.mockClear();
      const r = await setListenMinutesAction(INITIAL_STATE, form(b));
      expect(r.ok, JSON.stringify(b)).toBe(false);
      expect(r.error).toBe("Invalid interval.");
      expect(JSON.stringify(r)).not.toMatch(/script|not-a-uuid/);
      expect(logAdminAction).toHaveBeenCalledWith("listen_minutes_set", 422);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("a DB failure (migration not applied) returns the inline error, never throws", async () => {
    const spy = vi.spyOn(db() as any, "from").mockImplementation(() => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await setListenMinutesAction(INITIAL_STATE, form({ agent: "claude", device_id: devA, minutes: "9" }));
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/migration 20261013000007/);
      expect(r.error).not.toMatch(/relation|42P01/);
      expect(logAdminAction).toHaveBeenCalledWith("listen_minutes_set", 500);
    } finally { spy.mockRestore(); errSpy.mockRestore(); }
  });
  it("client-safe slider constants stay equal to the server ones (0..60, default 30)", () => {
    expect([UI_MIN, UI_MAX, UI_DEFAULT]).toEqual([LISTEN_MIN, LISTEN_MAX, LISTEN_DEFAULT]);
  });
});
