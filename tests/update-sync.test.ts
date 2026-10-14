// In-app Update button: tag-pinned fork sync (resolve the release tag to a commit, merge THAT commit) + error mapping.
// Fake fetch, no network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { syncFork, SYNC_OK_MESSAGE, syncUpToDateMessage } from "../lib/update/sync";

const TOKEN = "fake-test-token-0000";
const FORK = "me/my-board";
const UP = "Tekkiiiii/agency-board";
const TAG = "v1.2.0";
const COMMIT_SHA = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
const MOVED_SHA = "9999999999999999999999999999999999999999";
const TAG_OBJ_SHA = "8d05782cf7e01c815ceed85eac9d744533af4c44";
const REF_URL = `https://api.github.com/repos/${UP}/git/ref/tags/${TAG}`;
const MERGES_URL = `https://api.github.com/repos/${FORK}/merges`;

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
const lightweight = (sha = COMMIT_SHA) => res(200, { ref: `refs/tags/${TAG}`, object: { sha, type: "commit" } });

// Tag lookup answers with a lightweight tag; the merges POST answers with `merge`.
function gh(merge: (call: Call) => Response | Promise<Response>, sha = COMMIT_SHA) {
  return fakeFetch((call) => (call.init.method === "POST" ? merge(call) : lightweight(sha)));
}
const merges = (calls: Call[]) => calls.filter((c) => c.init.method === "POST");
const input = (fn: typeof fetch, over: Record<string, unknown> = {}) => ({
  fork: FORK,
  branch: "main",
  token: TOKEN,
  upstream: UP,
  tag: TAG,
  fetch: fn,
  ...over,
});

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

describe("syncFork: request shape", () => {
  it("resolves the tag, then POSTs exactly /repos/{fork}/merges with {base, head: <tag commit sha>, commit_message}", async () => {
    const f = gh(() => res(201, { sha: "m1", message: "Merge" }));
    const r = await syncFork(input(f.fn));
    expect(r).toEqual({ ok: true, message: SYNC_OK_MESSAGE });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].url).toBe(REF_URL);
    const [post] = merges(f.calls);
    expect(post.url).toBe(MERGES_URL);
    expect(post.url.startsWith("https://api.github.com/")).toBe(true);
    expect(post.init.method).toBe("POST");
    const body = JSON.parse(String(post.init.body));
    expect(body).toEqual({ base: "main", head: COMMIT_SHA, commit_message: `Update to ${TAG}` });
    expect(Object.keys(body).sort()).toEqual(["base", "commit_message", "head"]);
    expect(body.head).toMatch(/^[0-9a-f]{40}$/);
    expect(post.init.redirect).toBe("error");
    expect(post.init.signal).toBeInstanceOf(AbortSignal);
    const h = new Headers(post.init.headers);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("content-type")).toMatch(/^application\/json/);
    expect(h.get("user-agent")).toBeTruthy();
    expect(h.get("x-github-api-version")).toBeTruthy();
  });

  it("never calls merge-upstream, never uses a branch name as head, and sends Authorization only to api.github.com", async () => {
    const f = gh(() => res(201));
    await syncFork(input(f.fn));
    for (const c of f.calls) {
      expect(c.url).not.toContain("merge-upstream");
      expect(c.url.startsWith("https://api.github.com/repos/")).toBe(true);
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    }
    expect(JSON.parse(String(merges(f.calls)[0].init.body)).head).not.toBe("main");
  });

  it("dereferences an annotated tag before merging (head is the commit, not the tag object)", async () => {
    const f = fakeFetch((c) => {
      if (c.init.method === "POST") return res(201);
      if (c.url === REF_URL) return res(200, { ref: `refs/tags/${TAG}`, object: { sha: TAG_OBJ_SHA, type: "tag" } });
      if (c.url === `https://api.github.com/repos/${UP}/git/tags/${TAG_OBJ_SHA}`) return res(200, { object: { sha: COMMIT_SHA, type: "commit" } });
      return res(404);
    });
    expect((await syncFork(input(f.fn))).ok).toBe(true);
    expect(JSON.parse(String(merges(f.calls)[0].init.body)).head).toBe(COMMIT_SHA);
  });

  it("uses the given branch as base and the fork in the path", async () => {
    const f = gh(() => res(201));
    await syncFork(input(f.fn, { fork: "Org-1/repo.name_x", branch: "release/1.x" }));
    const [post] = merges(f.calls);
    expect(post.url).toBe("https://api.github.com/repos/Org-1/repo.name_x/merges");
    expect(JSON.parse(String(post.init.body)).base).toBe("release/1.x");
  });

  it("resolves the tag FRESH at sync time: a tag moved since the status check merges the new sha", async () => {
    const f = gh(() => res(201), MOVED_SHA);
    await syncFork(input(f.fn));
    expect(JSON.parse(String(merges(f.calls)[0].init.body)).head).toBe(MOVED_SHA);
    // and a second call resolves again (no caching)
    await syncFork(input(f.fn));
    expect(f.calls.filter((c) => c.url === REF_URL)).toHaveLength(2);
  });

  it("uses a custom upstream in the tag lookup path", async () => {
    const f = fakeFetch((c) =>
      c.init.method === "POST" ? res(201) : c.url === `https://api.github.com/repos/my-org/board/git/ref/tags/${TAG}` ? lightweight() : res(404),
    );
    expect((await syncFork(input(f.fn, { upstream: "my-org/board" }))).ok).toBe(true);
  });

  it("returns fixed success messages that contain neither the token nor the GitHub body", async () => {
    const f = gh(() => res(201, { message: `merged ${TOKEN} secret-body-marker` }));
    const r = await syncFork(input(f.fn));
    expect(r.ok).toBe(true);
    expect(r.message).not.toContain(TOKEN);
    expect(r.message).not.toContain("secret-body-marker");
    expect(consoleText()).not.toContain(TOKEN);
  });

  it.each([
    ["..", "main", UP, TAG],
    ["owner/..", "main", UP, TAG],
    ["a/b@evil", "main", UP, TAG],
    ["https://evil.com/x/y", "main", UP, TAG],
    ["", "main", UP, TAG],
    [FORK, "..", UP, TAG],
    [FORK, "a..b", UP, TAG],
    [FORK, "/x", UP, TAG],
    [FORK, "-x", UP, TAG],
    [FORK, 'main","evil":"1', UP, TAG],
    [FORK, "", UP, TAG],
    [FORK, "main", "a/b/../c", TAG],
    [FORK, "main", "evil.com/x/y", TAG],
    [FORK, "main", "", TAG],
    [FORK, "main", UP, ""],
    [FORK, "main", UP, ".."],
    [FORK, "main", UP, "v1/../x"],
    [FORK, "main", UP, "v 1"],
    [FORK, "main", UP, 'v1","x":"y'],
    [FORK, "main", UP, "a".repeat(101)],
  ])("refuses fork=%j branch=%j upstream=%j tag=%j without any fetch", async (fork, branch, upstream, tag) => {
    const f = gh(() => res(201));
    const r = await syncFork(input(f.fn, { fork, branch, upstream, tag }));
    expect(r.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(r.message).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
  });

  it.each(["", "  ", "tok\nen", "tok en\r\nX-Evil: 1"])("refuses an empty or malformed token %j without fetching", async (token) => {
    const f = gh(() => res(201));
    const r = await syncFork(input(f.fn, { token }));
    expect(r).toMatchObject({ ok: false, code: "auth" });
    expect(f.calls).toHaveLength(0);
  });
});

describe("syncFork: outcomes", () => {
  it("fork ahead of upstream: 201 merge commit created => ok with the sync message", async () => {
    const r = await syncFork(input(gh(() => res(201, { sha: "abc" })).fn));
    expect(r).toEqual({ ok: true, message: SYNC_OK_MESSAGE });
    expect(r).not.toHaveProperty("upToDate");
  });

  it("already contains the tag: 204 => ok + upToDate with a different fixed message", async () => {
    const r = await syncFork(input(gh(() => res(204)).fn));
    expect(r).toEqual({ ok: true, upToDate: true, message: syncUpToDateMessage(TAG) });
    expect(r.message).not.toBe(SYNC_OK_MESSAGE);
    expect(r.message).toContain(`already contains ${TAG}`);
    expect(r.message).toMatch(/Nothing to merge/);
    expect(consoleText()).toBe("");
  });

  it("the up-to-date message names the tag", async () => {
    const f = fakeFetch((c) =>
      c.init.method === "POST" ? res(204) : res(200, { ref: "refs/tags/v7.8.9", object: { sha: COMMIT_SHA, type: "commit" } }),
    );
    const r = await syncFork(input(f.fn, { tag: "v7.8.9" }));
    expect(r.ok && r.message).toContain("v7.8.9");
  });

  it("409 => conflict, pointing at resolving it on GitHub", async () => {
    const r = await syncFork(input(gh(() => res(409, ECHO)).fn));
    expect(r).toMatchObject({ ok: false, code: "conflict" });
    expect(r.message.toLowerCase()).toContain("conflict");
    expect(r.message.toLowerCase()).toContain("github");
    expect(r.message.toLowerCase()).toContain("manual sync");
  });

  it("404 'Head does not exist' (commit not in the fork's network) => unreachable with the manual-sync-link wording", async () => {
    const r = await syncFork(input(gh(() => res(404, { message: "Head does not exist" })).fn));
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    expect(r.message).toBe(
      "GitHub could not merge the release commit into your fork (the commit is not reachable from your fork, or GitHub rejected the request). Use the manual sync link to merge the release on GitHub.",
    );
  });

  it("422 => unreachable", async () => {
    const r = await syncFork(input(gh(() => res(422, { message: "Validation Failed" })).fn));
    expect(r).toMatchObject({ ok: false, code: "unreachable" });
    expect(r.message).toMatch(/manual sync link/);
  });

  it.each([
    ["Base does not exist"],
    ["Not Found"],
    [""],
    ["head does not exist but lowercase"],
    ["Something Head does not exist"],
  ])("404 %j (anything but a leading 'Head does not exist') => not_found", async (message) => {
    const r = await syncFork(input(gh(() => res(404, message ? { message } : "")).fn));
    expect(r).toMatchObject({ ok: false, code: "not_found" });
    expect(r.message).toMatch(/fork or the branch/);
  });

  it("404 with a non-JSON body and with an oversized body => not_found, never throws", async () => {
    expect(await syncFork(input(gh(() => res(404, "<html>nope</html>")).fn))).toMatchObject({ ok: false, code: "not_found" });
    const big = JSON.stringify({ message: "Head does not exist" }) + " ".repeat(50_000);
    expect(await syncFork(input(gh(() => res(404, big)).fn))).toMatchObject({ ok: false, code: "not_found" });
  });

  it("tag not found on upstream => tag_not_found, and NO merge call", async () => {
    const f = fakeFetch(() => res(404, { message: "Not Found" }));
    const r = await syncFork(input(f.fn));
    expect(r).toMatchObject({ ok: false, code: "tag_not_found" });
    expect(r.message).toBe(
      "The release tag was not found on upstream (it may have been removed or renamed). Nothing was changed. Try again later or use the manual sync link.",
    );
    expect(merges(f.calls)).toHaveLength(0);
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    ["500", () => res(500, ECHO)],
    ["bad shape", () => res(200, { ref: "refs/tags/other", object: { sha: COMMIT_SHA, type: "commit" } })],
    ["bad sha", () => res(200, { ref: `refs/tags/${TAG}`, object: { sha: "zz", type: "commit" } })],
    ["not json", () => res(200, "<html>")],
    ["network error", () => { throw new TypeError(`down ${TOKEN}`); }],
  ])("tag lookup unavailable (%s) => unknown, and NO merge call", async (_l, respond) => {
    const f = fakeFetch(respond);
    const r = await syncFork(input(f.fn));
    expect(r).toMatchObject({ ok: false, code: "unknown" });
    expect(merges(f.calls)).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it("a bad token is reported as auth even when it already fails at the tag lookup (401), with no merge call", async () => {
    const f = fakeFetch(() => res(401, ECHO));
    expect(await syncFork(input(f.fn))).toMatchObject({ ok: false, code: "auth" });
    expect(merges(f.calls)).toHaveLength(0);
  });

  it("throttling at the tag lookup is rate_limited (429, 403 + x-ratelimit-remaining 0)", async () => {
    for (const [st, h] of [[429, {}], [403, { "x-ratelimit-remaining": "0" }]] as [number, Record<string, string>][]) {
      expect(await syncFork(input(fakeFetch(() => res(st, ECHO, h)).fn))).toMatchObject({ ok: false, code: "rate_limited" });
    }
  });

  const table: [number, Record<string, string>, string][] = [
    [401, {}, "auth"],
    [403, {}, "auth"],
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [403, { "retry-after": "60" }, "rate_limited"],
    [429, {}, "rate_limited"],
    [500, {}, "unknown"],
    [502, {}, "unknown"],
    [418, {}, "unknown"],
    [200, {}, "unknown"],
    [301, {}, "unknown"],
  ];
  it.each(table)("merges HTTP %i %j => %s", async (status, headers, code) => {
    const f = gh(() => res(status, status === 301 ? "" : ECHO, headers));
    const r = await syncFork(input(f.fn));
    expect(r).toMatchObject({ ok: false, code });
    expect(r.message.length).toBeGreaterThan(10);
    expect(merges(f.calls)).toHaveLength(1);
  });

  it("the old 'diverged' code is gone", async () => {
    const r = await syncFork(input(gh(() => res(422)).fn));
    expect(r).not.toMatchObject({ code: "diverged" });
    expect(r.message.toLowerCase()).not.toContain("diverged");
  });

  it("mentions the Contents write permission for auth failures", async () => {
    const r = await syncFork(input(gh(() => res(403)).fn));
    expect(r.message).toMatch(/Contents/);
  });

  it("maps a network error on the merge POST to network", async () => {
    const f = fakeFetch((c) => {
      if (c.init.method === "POST") throw new TypeError(`fetch failed for Bearer ${TOKEN}`);
      return lightweight();
    });
    expect(await syncFork(input(f.fn))).toMatchObject({ ok: false, code: "network" });
  });

  it("maps a redirect error and a timeout on the POST to network, and never throws on non-Error throws", async () => {
    for (const err of [
      new TypeError("redirect mode is set to error"),
      Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
      TOKEN,
    ]) {
      const f = fakeFetch((c) => {
        if (c.init.method === "POST") throw err;
        return lightweight();
      });
      await expect(syncFork(input(f.fn))).resolves.toMatchObject({ ok: false, code: "network" });
    }
  });

  it("uses fixed messages: the same code yields the same text whatever the response body says", async () => {
    const a = await syncFork(input(gh(() => res(409, "alpha")).fn));
    const b = await syncFork(input(gh(() => res(409, ECHO)).fn));
    expect(a.message).toBe(b.message);
  });
});

describe("syncFork: the token and response bodies never leak", () => {
  const scenarios: [string, () => Response | never][] = [
    ["201 echoing the token", () => res(201, { message: ECHO })],
    ["401 echoing the token", () => res(401, ECHO)],
    ["403 echoing the token", () => res(403, { message: ECHO, documentation_url: TOKEN })],
    ["404 Head does not exist echoing the token", () => res(404, { message: `Head does not exist ${ECHO}` })],
    ["404 echoing the token", () => res(404, ECHO)],
    ["409 echoing the token", () => res(409, ECHO)],
    ["422 echoing the token", () => res(422, ECHO, { "x-echo": TOKEN })],
    ["429 echoing the token", () => res(429, ECHO, { "retry-after": "5", "x-echo": TOKEN })],
    ["500 echoing the token", () => res(500, ECHO)],
    ["network error carrying the token", () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); }],
  ];

  it.each(scenarios)("%s: not in the result, and not in console.log/info/warn/error", async (_label, respond) => {
    const r = await syncFork(input(gh(respond).fn));
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(JSON.stringify(r)).not.toContain("secret-body-marker");
    expect(JSON.stringify(r)).not.toContain("abc123");
    const out = consoleText();
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("secret-body-marker");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("Bearer");
  });

  it("logs failures through console.error with the status/code only", async () => {
    const r = await syncFork(input(gh(() => res(409, ECHO)).fn));
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
    await syncFork(input(gh(() => res(201)).fn));
    expect(consoleText()).toBe("");
  });

  it("does not retry (one tag lookup, one POST per call) and sends no force options", async () => {
    const f = gh(() => res(409));
    await syncFork(input(f.fn));
    expect(f.calls).toHaveLength(2);
    expect(merges(f.calls)).toHaveLength(1);
    expect(Object.keys(JSON.parse(String(merges(f.calls)[0].init.body))).sort()).toEqual(["base", "commit_message", "head"]);
  });
});
