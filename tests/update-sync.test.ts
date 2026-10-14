// In-app Update button: GitHub "sync fork" call + error mapping. Fake fetch, no network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { syncFork } from "../lib/update/sync";

const TOKEN = "fake-test-token-0000";
const FORK = "me/my-board";

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const NULL_BODY = [101, 204, 205, 304];
const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(NULL_BODY.includes(status) ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });

const spies = {
  log: vi.spyOn(console, "log"),
  info: vi.spyOn(console, "info"),
  warn: vi.spyOn(console, "warn"),
  error: vi.spyOn(console, "error"),
};
function consoleText(): string {
  return Object.values(spies)
    .flatMap((s) => s.mock.calls.map((c) => c.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 5 }))).join(" ")))
    .join("\n");
}
beforeEach(() => {
  for (const s of Object.values(spies)) s.mockReset().mockImplementation(() => {});
});
afterEach(() => {
  for (const s of Object.values(spies)) s.mockReset();
});

const ECHO = `Bad credentials for Bearer ${TOKEN}; request id abc123 secret-body-marker`;

describe("syncFork: request", () => {
  it("POSTs exactly /repos/{fork}/merge-upstream with body {branch} and the bearer token", async () => {
    const f = fakeFetch(() => res(200, { message: "Successfully fetched and fast-forwarded from upstream", merge_type: "fast-forward" }));
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(r.ok).toBe(true);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe("https://api.github.com/repos/me/my-board/merge-upstream");
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"branch":"main"}');
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("content-type")).toMatch(/^application\/json/);
    expect(h.get("user-agent")).toBeTruthy();
    expect(h.get("x-github-api-version")).toBeTruthy();
  });

  it("uses the given branch in the body and the fork in the path", async () => {
    const f = fakeFetch(() => res(200));
    await syncFork({ fork: "Org-1/repo.name_x", branch: "release/1.x", token: TOKEN, fetch: f.fn });
    expect(f.calls[0].url).toBe("https://api.github.com/repos/Org-1/repo.name_x/merge-upstream");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ branch: "release/1.x" });
  });

  it("returns a fixed success message that does not contain the token or the GitHub body", async () => {
    const f = fakeFetch(() => res(200, { message: `merged ${TOKEN} secret-body-marker` }));
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(r.ok).toBe(true);
    expect(r.message).toBeTruthy();
    expect(r.message).not.toContain(TOKEN);
    expect(r.message).not.toContain("secret-body-marker");
    expect(consoleText()).not.toContain(TOKEN);
  });

  it.each([
    ["..", "main"],
    ["owner/..", "main"],
    ["a/b@evil", "main"],
    ["a/b/../c", "main"],
    ["https://evil.com/x/y", "main"],
    ["a/b c", "main"],
    ["", "main"],
    [FORK, ".."],
    [FORK, "a..b"],
    [FORK, "/x"],
    [FORK, "-x"],
    [FORK, 'main","evil":"1'],
    [FORK, "ma in"],
    [FORK, ""],
  ])("refuses fork=%j branch=%j without any fetch", async (fork, branch) => {
    const f = fakeFetch(() => res(200));
    const r = await syncFork({ fork, branch, token: TOKEN, fetch: f.fn });
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(r.message).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
  });

  it.each(["", "  ", "tok\nen", "tok en\r\nX-Evil: 1"])("refuses an empty or malformed token %j without fetching", async (token) => {
    const f = fakeFetch(() => res(200));
    const r = await syncFork({ fork: FORK, branch: "main", token, fetch: f.fn });
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("syncFork: status mapping", () => {
  const table: [number, Record<string, string>, string][] = [
    [409, {}, "conflict"],
    [422, {}, "diverged"],
    [401, {}, "auth"],
    [403, {}, "auth"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [403, { "retry-after": "60" }, "rate_limited"],
    [404, {}, "not_found"],
    [429, {}, "rate_limited"],
    [500, {}, "unknown"],
    [502, {}, "unknown"],
    [418, {}, "unknown"],
    [204, {}, "unknown"],
    [301, {}, "unknown"],
  ];

  it.each(table)("HTTP %i %j -> %s", async (status, headers, code) => {
    const f = fakeFetch(() => res(status === 204 ? 204 : status, status === 204 || status === 301 ? "" : ECHO, headers));
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(r).toMatchObject({ ok: false, code });
    expect(typeof r.message).toBe("string");
    expect(r.message.length).toBeGreaterThan(10);
    expect(f.calls).toHaveLength(1);
  });

  it("maps 409 to a message pointing at resolving the conflict on GitHub, and 422 to a cannot-sync message", async () => {
    const conflict = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(409)).fn });
    expect(conflict.message.toLowerCase()).toContain("conflict");
    expect(conflict.message.toLowerCase()).toContain("github");
    const diverged = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(422)).fn });
    expect(diverged.message.toLowerCase()).toMatch(/cannot|can't|diverged/);
  });

  it("mentions the Contents write permission for auth failures", async () => {
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(403)).fn });
    expect(r.message).toMatch(/Contents/);
  });

  it("maps a network error (fetch rejects) to network", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
    });
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(r).toMatchObject({ ok: false, code: "network" });
  });

  it("maps a redirect error (redirect:error) and an abort/timeout to network", async () => {
    for (const err of [new TypeError("redirect mode is set to error"), Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" })]) {
      const f = fakeFetch(() => {
        throw err;
      });
      expect(await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn })).toMatchObject({ ok: false, code: "network" });
    }
  });

  it("never throws, even when fetch throws a non-Error", async () => {
    const f = fakeFetch(() => {
      throw TOKEN; // eslint-disable-line no-throw-literal
    });
    await expect(syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn })).resolves.toMatchObject({ ok: false, code: "network" });
  });

  it("uses fixed messages: the same code yields the same text whatever the response body says", async () => {
    const a = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(409, "alpha")).fn });
    const b = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(409, ECHO)).fn });
    expect(a.message).toBe(b.message);
  });
});

describe("syncFork: the token never leaks", () => {
  const scenarios: [string, () => Response | never][] = [
    ["200 echoing the token", () => res(200, { message: ECHO })],
    ["401 echoing the token", () => res(401, ECHO)],
    ["403 echoing the token", () => res(403, { message: ECHO, documentation_url: TOKEN })],
    ["404 echoing the token", () => res(404, ECHO)],
    ["409 echoing the token", () => res(409, ECHO)],
    ["422 echoing the token", () => res(422, ECHO, { "x-echo": TOKEN })],
    ["429 echoing the token", () => res(429, ECHO, { "retry-after": "5", "x-echo": TOKEN })],
    ["500 echoing the token", () => res(500, ECHO)],
    ["network error carrying the token", () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); }],
  ];

  it.each(scenarios)("%s: not in the result, and not in console.log/info/warn/error", async (_label, respond) => {
    const f = fakeFetch(respond);
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("secret-body-marker");
    expect(JSON.stringify(r)).not.toContain("abc123");
    const out = consoleText();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("secret-body-marker");
    expect(out).not.toContain("Bearer");
  });

  it("logs failures through console.error with the status/code only", async () => {
    const r = await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(409, ECHO)).fn });
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(spies.error).toHaveBeenCalledTimes(1);
    const out = consoleText();
    expect(out).toContain("409");
    expect(out).toContain("conflict");
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
  });

  it("logs nothing on success", async () => {
    await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: fakeFetch(() => res(200)).fn });
    expect(consoleText()).toBe("");
  });

  it("does not retry (exactly one POST per call, no force options in the body)", async () => {
    const f = fakeFetch(() => res(409));
    await syncFork({ fork: FORK, branch: "main", token: TOKEN, fetch: f.fn });
    expect(f.calls).toHaveLength(1);
    expect(Object.keys(JSON.parse(String(f.calls[0].init.body)))).toEqual(["branch"]);
  });
});
