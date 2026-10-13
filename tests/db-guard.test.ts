import { describe, it, expect } from "vitest";
import { isLocalUrl, assertSafeTestDb, resolveTestEnv, REMOTE_OPT_IN } from "./db-guard";

describe("isLocalUrl", () => {
  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "http://LOCALHOST:54321/",
    "http://[::1]:54321",
    "https://127.0.0.1",
    "http://127.0.0.1:54321/rest/v1",
  ])("allows %s", (u) => expect(isLocalUrl(u)).toBe(true));

  it.each([
    "https://abcdefghijklmnop.supabase.co",
    "https://example.com",
    "http://localhost.evil.com:54321",
    "http://127.0.0.1.evil.com",
    "http://evil.com/127.0.0.1",
    "http://evil.com/?h=localhost",
    "http://127.0.0.1@evil.com",
    "http://localhost:80@evil.com",
    "http://user:pw@evil.com:54321/localhost",
    "http://notlocalhost",
    "http://localhost.",
    "http://0.0.0.0:54321",
    "http://127.0.0.2:54321",
    "http://10.0.0.5:54321",
    "ftp://127.0.0.1",
    "127.0.0.1:54321",
    "",
    "   ",
    "not a url",
    "http://",
  ])("refuses %j", (u) => expect(isLocalUrl(u)).toBe(false));

  it("refuses undefined / null / non-strings", () => {
    expect(isLocalUrl(undefined)).toBe(false);
    expect(isLocalUrl(null)).toBe(false);
    expect(isLocalUrl(42 as unknown as string)).toBe(false);
  });
});

describe("assertSafeTestDb", () => {
  const prod = { SUPABASE_URL: "https://abcdefghijklmnop.supabase.co" };

  it("passes for a local URL", () => {
    expect(() => assertSafeTestDb({ SUPABASE_URL: "http://127.0.0.1:54321" })).not.toThrow();
  });
  it("refuses a remote URL with a clear message naming the opt-in var, without echoing the host or keys", () => {
    expect(() => assertSafeTestDb({ ...prod, SUPABASE_SERVICE_ROLE_KEY: "secret-key-123" }))
      .toThrow(/refusing to run the tests against a non-local database/i);
    try { assertSafeTestDb({ ...prod, SUPABASE_SERVICE_ROLE_KEY: "secret-key-123" }); } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain(REMOTE_OPT_IN);
      expect(m).not.toContain("secret-key-123");
      expect(m).not.toContain("abcdefgh");
    }
  });
  it("refuses empty / missing / invalid URL", () => {
    expect(() => assertSafeTestDb({})).toThrow();
    expect(() => assertSafeTestDb({ SUPABASE_URL: "" })).toThrow();
    expect(() => assertSafeTestDb({ SUPABASE_URL: "garbage" })).toThrow();
  });
  it("refuses lookalike hosts", () => {
    expect(() => assertSafeTestDb({ SUPABASE_URL: "http://localhost.evil.com" })).toThrow();
    expect(() => assertSafeTestDb({ SUPABASE_URL: "http://127.0.0.1@evil.com" })).toThrow();
  });
  it("opt-in =1 allows a remote URL; other values do not", () => {
    expect(() => assertSafeTestDb({ ...prod, [REMOTE_OPT_IN]: "1" })).not.toThrow();
    for (const v of ["0", "true", "yes", "", " 1"]) {
      expect(() => assertSafeTestDb({ ...prod, [REMOTE_OPT_IN]: v })).toThrow();
    }
  });
  it("opt-in still requires a URL to be set at all", () => {
    expect(() => assertSafeTestDb({ [REMOTE_OPT_IN]: "1" })).toThrow();
  });
});

describe("resolveTestEnv (final resolved env is what gets guarded)", () => {
  const local = () => ({ API_URL: "http://127.0.0.1:54321", ANON_KEY: "a", SERVICE_ROLE_KEY: "s" });
  const noStack = () => { throw new Error("stack down"); };

  it("defaults to the local stack when nothing is set", () => {
    const r = resolveTestEnv({}, {}, local);
    expect(r.SUPABASE_URL).toBe("http://127.0.0.1:54321");
    expect(r.SUPABASE_SERVICE_ROLE_KEY).toBe("s");
    expect(r.SUPABASE_ANON_KEY).toBe("a");
  });
  it("does not call the stack probe when the URL and key are already given", () => {
    const r = resolveTestEnv({ SUPABASE_URL: "http://localhost:1", SUPABASE_SERVICE_ROLE_KEY: "k" }, {}, noStack);
    expect(r.SUPABASE_URL).toBe("http://localhost:1");
  });
  it("test env file supplies values; shell SUPABASE_* wins over the file", () => {
    const file = { SUPABASE_URL: "http://localhost:2", SUPABASE_SERVICE_ROLE_KEY: "fk", CRON_SECRET: "c" };
    expect(resolveTestEnv({}, file, noStack).SUPABASE_URL).toBe("http://localhost:2");
    expect(resolveTestEnv({ SUPABASE_URL: "http://127.0.0.1:9" }, file, noStack).SUPABASE_URL).toBe("http://127.0.0.1:9");
    expect(resolveTestEnv({}, file, noStack).CRON_SECRET).toBe("c");
  });
  it("a prod SUPABASE_URL leaked from the parent shell stays visible so the guard refuses it", () => {
    const r = resolveTestEnv({ SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" }, {}, local);
    expect(r.SUPABASE_URL).toContain("supabase.co");
    expect(() => assertSafeTestDb(r)).toThrow();
  });
  it("throws a helpful error when the stack is down and nothing else is configured", () => {
    expect(() => resolveTestEnv({}, {}, noStack)).toThrow(/supabase start/);
  });
});
