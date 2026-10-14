// In-app Update button: upstream release lookup + migration-count lookup (unauthenticated, cached, shape-validated).
// A fake fetch is injected everywhere: no network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { DEFAULT_UPSTREAM } from "../lib/update/config";
import {
  fetchLatestRelease,
  fetchMigrationVersions,
  fetchTagCommit,
  pendingMigrationCount,
  resolveTagCommit,
  __resetCacheForTests,
} from "../lib/update/release";

const TOKEN = "fake-test-token-0000";
const UP = DEFAULT_UPSTREAM;
const RELEASE_URL = `https://api.github.com/repos/${UP}/releases/latest`;

type Call = { url: string; init: RequestInit };
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response([101, 204, 205, 304].includes(status) ? null : typeof body === "string" ? body : JSON.stringify(body), { status, headers });

function release(over: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.0",
    name: "Release 1.2.0",
    body: "## Changes\n- one\n- two",
    html_url: `https://github.com/${UP}/releases/tag/v1.2.0`,
    published_at: "2026-10-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...over,
  };
}

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
  __resetCacheForTests();
  for (const s of Object.values(spies)) s.mockReset().mockImplementation(() => {});
});
afterEach(() => {
  for (const s of Object.values(spies)) s.mockReset();
});

describe("fetchLatestRelease: request shape", () => {
  it("GETs the literal api.github.com releases/latest URL with redirect:error, a timeout signal and NO Authorization", async () => {
    const f = fakeFetch(() => json(release()));
    const env = { AGENCY_BOARD_GITHUB_TOKEN: TOKEN, GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN };
    const r = await fetchLatestRelease({ fetch: f.fn, env });
    expect(r).not.toBeNull();
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(RELEASE_URL);
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init.method ?? "GET").toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.body).toBeUndefined();
    const h = new Headers(init.headers);
    expect(h.has("authorization")).toBe(false);
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("user-agent")).toBe("agency-board-update-check");
    expect(h.get("x-github-api-version")).toBeTruthy();
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
  });

  it("uses an upstream override in the path only; the host stays api.github.com", async () => {
    const f = fakeFetch(() => json(release({ html_url: "https://github.com/my-org/board/releases/tag/v1.2.0" })));
    const r = await fetchLatestRelease({ fetch: f.fn, env: { AGENCY_BOARD_UPSTREAM: "my-org/board" } });
    expect(r?.url).toBe("https://github.com/my-org/board/releases/tag/v1.2.0");
    expect(f.calls[0].url).toBe("https://api.github.com/repos/my-org/board/releases/latest");
  });

  it.each(["evil.com/x", "https://evil.com/x/y", "a/b@evil", "a/b/../c", "owner/..", "..", "a/b c"])(
    "never fetches when the upstream override is invalid (%j)",
    async (bad) => {
      const f = fakeFetch(() => json(release()));
      expect(await fetchLatestRelease({ fetch: f.fn, env: { AGENCY_BOARD_UPSTREAM: bad } })).toBeNull();
      expect(f.calls).toHaveLength(0);
    },
  );

  it("does not follow URLs found in the response (host is never derived from a response)", async () => {
    const f = fakeFetch(() =>
      json({ ...release(), url: "https://evil.example/x", assets_url: "https://evil.example/a", upload_url: "https://evil.example/u" }),
    );
    await fetchLatestRelease({ fetch: f.fn });
    expect(f.calls.map((c) => c.url)).toEqual([RELEASE_URL]);
  });
});

describe("fetchLatestRelease: result shape", () => {
  it("maps a valid release", async () => {
    const f = fakeFetch(() => json(release()));
    expect(await fetchLatestRelease({ fetch: f.fn })).toEqual({
      tag: "v1.2.0",
      version: "1.2.0",
      name: "Release 1.2.0",
      body: "## Changes\n- one\n- two",
      url: `https://github.com/${UP}/releases/tag/v1.2.0`,
      publishedAt: "2026-10-01T00:00:00Z",
    });
  });

  it("accepts null name/body/published_at as empty (GitHub sends null for blank notes)", async () => {
    const f = fakeFetch(() => json(release({ name: null, body: null, published_at: null })));
    const r = await fetchLatestRelease({ fetch: f.fn });
    expect(r).toMatchObject({ name: "", body: "", publishedAt: null });
  });

  it("truncates a huge body to 4000 chars", async () => {
    const f = fakeFetch(() => json(release({ body: "x".repeat(50_000) })));
    const r = await fetchLatestRelease({ fetch: f.fn });
    expect(r?.body.length).toBeLessThanOrEqual(4000);
    expect(r?.body.length).toBeGreaterThan(3000);
  });

  it("strips control characters from the notes but keeps newlines and tabs", async () => {
    const f = fakeFetch(() => json(release({ body: "a\u0000b\u001bc\nd\te" })));
    expect((await fetchLatestRelease({ fetch: f.fn }))?.body).toBe("abc\nd\te");
  });

  it("strips Unicode bidi and zero-width characters from name and notes", async () => {
    const evil = "a\u200Bb\u200Cc\u200Dd\u200Ee\u200Ff\u202Ag\u202Bh\u202Ci\u202Dj\u202Ek\u2066l\u2067m\u2068n\u2069o\uFEFFp";
    const f = fakeFetch(() => json(release({ name: evil, body: evil + "\nline" })));
    const r = await fetchLatestRelease({ fetch: f.fn });
    expect(r?.name).toBe("abcdefghijklmnop");
    expect(r?.body).toBe("abcdefghijklmnop\nline");
  });

  it("returns null when the whole response is absurdly large", async () => {
    const f = fakeFetch(() => json(release({ body: "x".repeat(3_000_000) })));
    expect(await fetchLatestRelease({ fetch: f.fn })).toBeNull();
  });

  it.each([
    ["html_url on another host", { html_url: `https://evil.com/${UP}/releases/tag/v1.2.0` }],
    ["html_url on a lookalike host", { html_url: `https://github.com.evil.com/${UP}/releases/tag/v1.2.0` }],
    ["html_url on a lookalike repo", { html_url: `https://github.com/${UP}-evil/releases/tag/v1.2.0` }],
    ["html_url over http", { html_url: `http://github.com/${UP}/releases/tag/v1.2.0` }],
    ["html_url with a .. path segment", { html_url: `https://github.com/${UP}/releases/tag/../../../evil` }],
    ["html_url with an encoded %2e dot segment", { html_url: `https://github.com/${UP}/releases/tag/%2e%2e/evil` }],
    ["html_url with an upper-case %2E dot segment", { html_url: `https://github.com/${UP}/releases/tag/%2E%2E/evil` }],
    ["html_url with a mixed-case .%2e dot segment", { html_url: `https://github.com/${UP}/releases/tag/.%2E/evil` }],
    ["html_url missing", { html_url: undefined }],
    ["html_url not a string", { html_url: 5 }],
    ["body is a number", { body: 123 }],
    ["body is an object", { body: { a: 1 } }],
    ["body is an array", { body: ["x"] }],
    ["name is an object", { name: {} }],
    ["tag_name missing", { tag_name: undefined }],
    ["tag_name not semver", { tag_name: "latest" }],
    ["tag_name has path chars", { tag_name: "v1.2.0/../x" }],
    ["tag_name has query chars", { tag_name: "v1.2.0&ref=x" }],
    ["tag_name not a string", { tag_name: 120 }],
    ["draft release", { draft: true }],
    ["prerelease flag", { prerelease: true }],
    ["published_at not a string", { published_at: 7 }],
  ])("returns null for %s", async (_label, over) => {
    const f = fakeFetch(() => json(release(over as Record<string, unknown>)));
    expect(await fetchLatestRelease({ fetch: f.fn })).toBeNull();
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"v1.2.0"'],
    ["html", "<html><body>rate limited</body></html>"],
    ["empty", ""],
    ["truncated json", '{"tag_name":"v1.'],
  ])("returns null for a %s payload", async (_label, raw) => {
    const f = fakeFetch(() => json(raw));
    expect(await fetchLatestRelease({ fetch: f.fn })).toBeNull();
  });

  it.each([301, 302, 304, 403, 404, 429, 500, 503])("returns null for HTTP %i", async (status) => {
    const f = fakeFetch(() => json(release(), status));
    expect(await fetchLatestRelease({ fetch: f.fn })).toBeNull();
  });

  it("returns null (never throws) when fetch rejects, including redirect errors", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed ${TOKEN}`);
    });
    await expect(fetchLatestRelease({ fetch: f.fn })).resolves.toBeNull();
    expect(consoleText()).not.toContain(TOKEN);
  });

  it("returns null (never throws) when fetch throws synchronously", async () => {
    const fn = (() => {
      throw new Error("sync boom");
    }) as unknown as typeof fetch;
    await expect(fetchLatestRelease({ fetch: fn })).resolves.toBeNull();
  });
});

describe("fetchLatestRelease: cache", () => {
  it("makes one fetch for N calls within the TTL, including concurrent ones", async () => {
    let t = 1_000_000;
    const f = fakeFetch(() => json(release()));
    const opts = { fetch: f.fn, now: () => t };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => fetchLatestRelease(opts)));
    expect(results.every((r) => r?.tag === "v1.2.0")).toBe(true);
    t += 59 * 60 * 1000;
    await fetchLatestRelease(opts);
    await fetchLatestRelease(opts);
    expect(f.calls).toHaveLength(1);
  });

  it("expires after the TTL (default 1 h) and refetches", async () => {
    let t = 1_000_000;
    let tag = "v1.2.0";
    const f = fakeFetch(() => json(release({ tag_name: tag, html_url: `https://github.com/${UP}/releases/tag/${tag}` })));
    const opts = { fetch: f.fn, now: () => t };
    expect((await fetchLatestRelease(opts))?.tag).toBe("v1.2.0");
    t += 60 * 60 * 1000 + 1;
    tag = "v1.3.0";
    expect((await fetchLatestRelease(opts))?.tag).toBe("v1.3.0");
    expect(f.calls).toHaveLength(2);
  });

  it("honours a custom ttlMs", async () => {
    let t = 0;
    const f = fakeFetch(() => json(release()));
    const opts = { fetch: f.fn, now: () => t, ttlMs: 1000 };
    await fetchLatestRelease(opts);
    t = 999;
    await fetchLatestRelease(opts);
    expect(f.calls).toHaveLength(1);
    t = 1001;
    await fetchLatestRelease(opts);
    expect(f.calls).toHaveLength(2);
  });

  it("negative-caches a failure for about 5 minutes, then retries", async () => {
    let t = 5_000_000;
    let fail = true;
    const f = fakeFetch(() => (fail ? json("nope", 500) : json(release())));
    const opts = { fetch: f.fn, now: () => t };
    expect(await fetchLatestRelease(opts)).toBeNull();
    for (let i = 0; i < 10; i++) expect(await fetchLatestRelease(opts)).toBeNull();
    expect(f.calls).toHaveLength(1);
    t += 4 * 60 * 1000;
    expect(await fetchLatestRelease(opts)).toBeNull();
    expect(f.calls).toHaveLength(1);
    fail = false;
    t += 2 * 60 * 1000; // 6 min after the failure
    expect((await fetchLatestRelease(opts))?.tag).toBe("v1.2.0");
    expect(f.calls).toHaveLength(2);
  });

  it("negative-caches a network error and an anomalous payload too", async () => {
    const t = 0;
    const down = fakeFetch(() => {
      throw new TypeError("network down");
    });
    await fetchLatestRelease({ fetch: down.fn, now: () => t });
    await fetchLatestRelease({ fetch: down.fn, now: () => t });
    expect(down.calls).toHaveLength(1);

    __resetCacheForTests();
    const bad = fakeFetch(() => json(release({ html_url: "https://evil.com/x" })));
    await fetchLatestRelease({ fetch: bad.fn, now: () => t });
    await fetchLatestRelease({ fetch: bad.fn, now: () => t });
    expect(bad.calls).toHaveLength(1);
  });

  it("keeps separate cache entries per upstream", async () => {
    const f = fakeFetch((url) =>
      json(release({ html_url: `https://github.com/${url.includes("my-org/board") ? "my-org/board" : UP}/releases/tag/v1.2.0` })),
    );
    await fetchLatestRelease({ fetch: f.fn });
    await fetchLatestRelease({ fetch: f.fn, env: { AGENCY_BOARD_UPSTREAM: "my-org/board" } });
    expect(f.calls).toHaveLength(2);
  });

  it("__resetCacheForTests clears the cache", async () => {
    const f = fakeFetch(() => json(release()));
    await fetchLatestRelease({ fetch: f.fn });
    __resetCacheForTests();
    await fetchLatestRelease({ fetch: f.fn });
    expect(f.calls).toHaveLength(2);
  });
});


// ---- tag -> commit resolution (real-shaped fixtures: pallets/flask 3.1.3 is an annotated tag) ----

const TAG_OBJ_SHA = "8d05782cf7e01c815ceed85eac9d744533af4c44";
const COMMIT_SHA = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
const TAG2_OBJ_SHA = "1111111111111111111111111111111111111111";
const TAG3_OBJ_SHA = "2222222222222222222222222222222222222222";
const TAG4_OBJ_SHA = "3333333333333333333333333333333333333333";
const REF_URL = (tag: string, up = UP) => `https://api.github.com/repos/${up}/git/ref/tags/${tag}`;
const TAGOBJ_URL = (sha: string, up = UP) => `https://api.github.com/repos/${up}/git/tags/${sha}`;
const refBody = (tag: string, sha: string, type: string) => ({
  ref: `refs/tags/${tag}`,
  node_id: "x",
  url: `https://api.github.com/repos/${UP}/git/refs/tags/${tag}`,
  object: { sha, type, url: "https://evil.example/x" },
});
const tagBody = (sha: string, type: string) => ({ sha, tag: "3.1.3", object: { sha, type, url: "https://evil.example/y" }, message: "m" });

describe("resolveTagCommit", () => {
  it("lightweight tag: one GET to git/ref/tags/<tag>, returns the commit sha", async () => {
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    const r = await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn });
    expect(r).toEqual({ ok: true, sha: COMMIT_SHA });
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(REF_URL("v1.2.0"));
    expect(init.method ?? "GET").toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("annotated tag: dereferences through git/tags/<sha> to the commit", async () => {
    const f = fakeFetch((url) =>
      url === REF_URL("3.1.3", "pallets/flask")
        ? json(refBody("3.1.3", TAG_OBJ_SHA, "tag"))
        : url === TAGOBJ_URL(TAG_OBJ_SHA, "pallets/flask")
          ? json(tagBody(COMMIT_SHA, "commit"))
          : json({}, 404),
    );
    const r = await resolveTagCommit({ upstream: "pallets/flask", tag: "3.1.3", fetch: f.fn });
    expect(r).toEqual({ ok: true, sha: COMMIT_SHA });
    expect(f.calls.map((c) => c.url)).toEqual([REF_URL("3.1.3", "pallets/flask"), TAGOBJ_URL(TAG_OBJ_SHA, "pallets/flask")]);
  });

  it("nested annotated tags: follows up to 3 levels", async () => {
    const f = fakeFetch((url) => {
      if (url === REF_URL("v1.2.0")) return json(refBody("v1.2.0", TAG_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG_OBJ_SHA)) return json(tagBody(TAG2_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG2_OBJ_SHA)) return json(tagBody(TAG3_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG3_OBJ_SHA)) return json(tagBody(COMMIT_SHA, "commit"));
      return json({}, 404);
    });
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: true, sha: COMMIT_SHA });
    expect(f.calls).toHaveLength(4);
  });

  it("more than 3 dereference levels is unavailable", async () => {
    const f = fakeFetch((url) => {
      if (url === REF_URL("v1.2.0")) return json(refBody("v1.2.0", TAG_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG_OBJ_SHA)) return json(tagBody(TAG2_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG2_OBJ_SHA)) return json(tagBody(TAG3_OBJ_SHA, "tag"));
      if (url === TAGOBJ_URL(TAG3_OBJ_SHA)) return json(tagBody(TAG4_OBJ_SHA, "tag"));
      return json(tagBody(COMMIT_SHA, "commit"));
    });
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: false, reason: "unavailable" });
    expect(f.calls.length).toBeLessThanOrEqual(4);
  });

  it("HTTP 404 on the ref is not_found", async () => {
    const f = fakeFetch(() => json({ message: "Not Found" }, 404));
    expect(await resolveTagCommit({ upstream: UP, tag: "v9.9.9", fetch: f.fn })).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([500, 403, 429, 301, 422])("HTTP %i on the ref is unavailable and carries the status", async (status) => {
    const f = fakeFetch(() => json({ message: "x" }, status));
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({
      ok: false,
      reason: "unavailable",
      status,
      ...(status === 429 ? { limited: true } : {}),
    });
  });

  it("flags throttling (429, 403 with x-ratelimit-remaining 0 or retry-after) so the caller can tell it from a bad token", async () => {
    for (const [status, headers] of [
      [429, {}],
      [403, { "x-ratelimit-remaining": "0" }],
      [403, { "retry-after": "60" }],
    ] as [number, Record<string, string>][]) {
      const f = fakeFetch(() => json({ message: "x" }, status, headers));
      expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: false, reason: "unavailable", status, limited: true });
    }
    const plain = fakeFetch(() => json({ message: "x" }, 403));
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: plain.fn })).toEqual({ ok: false, reason: "unavailable", status: 403 });
  });

  it("a 404 while dereferencing an annotated tag object is unavailable (not not_found)", async () => {
    const f = fakeFetch((url) => (url === REF_URL("v1.2.0") ? json(refBody("v1.2.0", TAG_OBJ_SHA, "tag")) : json({}, 404)));
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it.each([
    ["ref name mismatch", { ref: "refs/tags/v9.9.9", object: { sha: COMMIT_SHA, type: "commit" } }],
    ["ref is a branch", { ref: "refs/heads/v1.2.0", object: { sha: COMMIT_SHA, type: "commit" } }],
    ["sha too short", { ref: "refs/tags/v1.2.0", object: { sha: "abc123", type: "commit" } }],
    ["sha uppercase", { ref: "refs/tags/v1.2.0", object: { sha: COMMIT_SHA.toUpperCase(), type: "commit" } }],
    ["sha with a path", { ref: "refs/tags/v1.2.0", object: { sha: `${COMMIT_SHA.slice(0, 30)}/../../x`, type: "commit" } }],
    ["sha not a string", { ref: "refs/tags/v1.2.0", object: { sha: 42, type: "commit" } }],
    ["unknown object type (tree)", { ref: "refs/tags/v1.2.0", object: { sha: COMMIT_SHA, type: "tree" } }],
    ["unknown object type (blob)", { ref: "refs/tags/v1.2.0", object: { sha: COMMIT_SHA, type: "blob" } }],
    ["missing object", { ref: "refs/tags/v1.2.0" }],
    ["object is an array", { ref: "refs/tags/v1.2.0", object: [] }],
    ["an array response", [{ ref: "refs/tags/v1.2.0" }]],
    ["a string response", "oops"],
  ])("shape anomaly (%s) is unavailable", async (_l, payload) => {
    const f = fakeFetch(() => json(payload as never));
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: false, reason: "unavailable" });
    expect(f.calls).toHaveLength(1);
  });

  it("a malformed sha from the tag object (second hop) is unavailable", async () => {
    const f = fakeFetch((url) =>
      url === REF_URL("v1.2.0") ? json(refBody("v1.2.0", TAG_OBJ_SHA, "tag")) : json(tagBody("not-a-sha", "commit")),
    );
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: false, reason: "unavailable" });
  });

  it("never requests a URL built from a response (evil urls in bodies are ignored)", async () => {
    const f = fakeFetch((url) =>
      url === REF_URL("v1.2.0") ? json(refBody("v1.2.0", TAG_OBJ_SHA, "tag")) : json(tagBody(COMMIT_SHA, "commit")),
    );
    await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn });
    for (const c of f.calls) expect(c.url.startsWith("https://api.github.com/repos/")).toBe(true);
    expect(f.calls.some((c) => c.url.includes("evil"))).toBe(false);
  });

  it.each(["", "v1/../x", "..", "v 1", "v1?x=1", "v1#x", "a".repeat(101), "v1.2.0/../../x", "v1\n"])(
    "refuses tag %j without any fetch (unavailable)",
    async (tag) => {
      const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
      expect(await resolveTagCommit({ upstream: UP, tag, fetch: f.fn })).toEqual({ ok: false, reason: "unavailable" });
      expect(f.calls).toHaveLength(0);
    },
  );

  it.each(["..", "a/b/../c", "evil.com/x/y/z", "a/b c"])("refuses upstream %j without any fetch", async (upstream) => {
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    expect(await resolveTagCommit({ upstream, tag: "v1.2.0", fetch: f.fn })).toEqual({ ok: false, reason: "unavailable" });
    expect(f.calls).toHaveLength(0);
  });

  it("returns unavailable (never throws) on network errors, sync throws and oversize bodies", async () => {
    const down = fakeFetch(() => {
      throw new TypeError(`down ${TOKEN}`);
    });
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: down.fn })).toEqual({ ok: false, reason: "unavailable" });
    const big = fakeFetch(() => json("x".repeat(1_000_001)));
    expect(await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: big.fn })).toEqual({ ok: false, reason: "unavailable" });
    expect(consoleText()).not.toContain(TOKEN);
  });

  it("sends Authorization only when a token is given, and only to api.github.com", async () => {
    const f = fakeFetch((url) =>
      url === REF_URL("v1.2.0") ? json(refBody("v1.2.0", TAG_OBJ_SHA, "tag")) : json(tagBody(COMMIT_SHA, "commit")),
    );
    await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn, token: TOKEN });
    expect(f.calls).toHaveLength(2);
    for (const c of f.calls) {
      expect(c.url.startsWith("https://api.github.com/")).toBe(true);
      expect(new Headers(c.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(c.init.redirect).toBe("error");
    }
    const g = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: g.fn });
    expect(new Headers(g.calls[0].init.headers).has("authorization")).toBe(false);
  });

  it("encodes the tag segment and does not cache (every call fetches)", async () => {
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn });
    await resolveTagCommit({ upstream: UP, tag: "v1.2.0", fetch: f.fn });
    expect(f.calls).toHaveLength(2);
  });
});

describe("fetchTagCommit (cached, unauthenticated)", () => {
  it("resolves via the upstream from env, no Authorization even when a token is in env, and caches per tag", async () => {
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    const env = { AGENCY_BOARD_GITHUB_TOKEN: TOKEN };
    expect(await fetchTagCommit({ tag: "v1.2.0", fetch: f.fn, env })).toBe(COMMIT_SHA);
    expect(await fetchTagCommit({ tag: "v1.2.0", fetch: f.fn, env })).toBe(COMMIT_SHA);
    expect(f.calls).toHaveLength(1);
    expect(new Headers(f.calls[0].init.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
    await fetchTagCommit({ tag: "v1.3.0", fetch: f.fn, env });
    expect(f.calls).toHaveLength(2);
  });

  it("keys the cache per upstream and expires after the TTL", async () => {
    let t = 0;
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    const opts = { tag: "v1.2.0", fetch: f.fn, now: () => t };
    await fetchTagCommit(opts);
    await fetchTagCommit({ ...opts, env: { AGENCY_BOARD_UPSTREAM: "someorg/other-board" } });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url).toBe(REF_URL("v1.2.0", "someorg/other-board"));
    t = 60 * 60 * 1000 + 1;
    await fetchTagCommit(opts);
    expect(f.calls).toHaveLength(3);
  });

  it("is null on not_found/unavailable and negative-caches the failure", async () => {
    const f = fakeFetch(() => json({}, 404));
    expect(await fetchTagCommit({ tag: "v1.2.0", fetch: f.fn, now: () => 0 })).toBeNull();
    expect(await fetchTagCommit({ tag: "v1.2.0", fetch: f.fn, now: () => 1000 })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("is null for an invalid upstream override without any fetch", async () => {
    const f = fakeFetch(() => json(refBody("v1.2.0", COMMIT_SHA, "commit")));
    expect(await fetchTagCommit({ tag: "v1.2.0", fetch: f.fn, env: { AGENCY_BOARD_UPSTREAM: "a/b/../c" } })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

const MIG_URL = (sha: string, up = UP) => `https://api.github.com/repos/${up}/contents/supabase/migrations?ref=${sha}`;
const files = (...names: string[]) => names.map((name) => ({ name, type: "file", path: `supabase/migrations/${name}`, download_url: "https://evil.example/x" }));

describe("fetchMigrationVersions (on the release commit, not the default branch)", () => {
  it("GETs the contents API with ?ref=<sha>, unauthenticated, and returns sorted 14-digit versions", async () => {
    const f = fakeFetch(() =>
      json([
        ...files("20261008000006_blocked_and_notify.sql", "20261007000003_drop_token_scopes.sql"),
        ...files("README.md", "notes.txt", "2026_short.sql", "20261013000007x_bad.sql", "../20261013000009_evil.sql"),
        { name: "20261014000008_dir.sql", type: "dir" },
        { type: "file" },
        "junk",
        null,
      ]),
    );
    const v = await fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn, env: { AGENCY_BOARD_GITHUB_TOKEN: TOKEN } });
    expect(v).toEqual(["20261007000003", "20261008000006"]);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(MIG_URL(COMMIT_SHA));
    expect(url).toContain(`?ref=${COMMIT_SHA}`);
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
    expect(f.calls.map((c) => c.url).some((u) => u.includes("evil"))).toBe(false);
  });

  it("dedupes versions", async () => {
    const f = fakeFetch(() => json(files("20261007000003_a.sql", "20261007000003_b.sql")));
    expect(await fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn })).toEqual(["20261007000003"]);
  });

  it.each(["", "main", "abc", COMMIT_SHA.toUpperCase(), `${COMMIT_SHA}x`, "../x"])("refuses sha %j without any fetch (null)", async (sha) => {
    const f = fakeFetch(() => json(files("20261007000003_a.sql")));
    expect(await fetchMigrationVersions({ sha, fetch: f.fn })).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    ["an object", { message: "Not Found" }],
    ["a string", "x"],
    ["html", "<html>"],
  ])("returns null for %s", async (_l, payload) => {
    const f = fakeFetch(() => json(payload as never));
    expect(await fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn })).toBeNull();
  });

  it.each([403, 404, 500])("returns null for HTTP %i and negative-caches it", async (status) => {
    const f = fakeFetch(() => json([], status));
    expect(await fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn, now: () => 0 })).toBeNull();
    expect(await fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn, now: () => 1000 })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("caches per upstream and sha (key migrations:<upstream>:<sha>) for the TTL", async () => {
    let t = 0;
    const f = fakeFetch(() => json(files("20261007000003_a.sql")));
    const opts = { sha: COMMIT_SHA, fetch: f.fn, now: () => t };
    await fetchMigrationVersions(opts);
    await fetchMigrationVersions(opts);
    expect(f.calls).toHaveLength(1);
    await fetchMigrationVersions({ ...opts, env: { AGENCY_BOARD_UPSTREAM: "someorg/other-board" } });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url).toBe(MIG_URL(COMMIT_SHA, "someorg/other-board"));
    await fetchMigrationVersions({ ...opts, sha: TAG_OBJ_SHA });
    expect(f.calls).toHaveLength(3);
    expect(f.calls[2].url).toBe(MIG_URL(TAG_OBJ_SHA));
    t = 60 * 60 * 1000 + 1;
    await fetchMigrationVersions(opts);
    expect(f.calls).toHaveLength(4);
  });

  it("never throws on a network error", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("down");
    });
    await expect(fetchMigrationVersions({ sha: COMMIT_SHA, fetch: f.fn })).resolves.toBeNull();
  });
});

describe("pendingMigrationCount (counted on the release TAG's tree)", () => {
  const upstream = files("20261007000003_a.sql", "20261008000006_b.sql", "20261013000007_c.sql", "20261020000008_d.sql");
  // Routes the tag lookup and the pinned contents lookup; a default-branch listing (no ?ref=) returns a DIFFERENT list.
  const routed = (tagStatus = 200) =>
    fakeFetch((url) => {
      if (url === REF_URL("v1.2.0")) return tagStatus === 200 ? json(refBody("v1.2.0", COMMIT_SHA, "commit")) : json({}, tagStatus);
      if (url === MIG_URL(COMMIT_SHA)) return json(upstream);
      if (url.includes("/contents/supabase/migrations")) return json(files("20261099000099_default_branch_only.sql"));
      return json({}, 404);
    });
  const opts = (f: ReturnType<typeof routed>, bundled: readonly string[] | null) => ({ tag: "v1.2.0", fetch: f.fn, bundled });

  it("resolves tag -> sha first and requests contents?ref=<sha of the tag>, never the default branch", async () => {
    const f = routed();
    const n = await pendingMigrationCount(opts(f, ["20261007000003", "20261008000006", "20261013000007"]));
    expect(n).toBe(1);
    expect(f.calls.map((c) => c.url)).toEqual([REF_URL("v1.2.0"), MIG_URL(COMMIT_SHA)]);
    expect(f.calls.some((c) => c.url.endsWith("/contents/supabase/migrations"))).toBe(false);
    for (const c of f.calls) expect(new Headers(c.init.headers).has("authorization")).toBe(false);
  });

  it("is 0 when everything is bundled, and ignores bundled versions the tag no longer has", async () => {
    const all = ["20261007000003", "20261008000006", "20261013000007", "20261020000008", "20250101000000"];
    expect(await pendingMigrationCount(opts(routed(), all))).toBe(0);
  });

  it("is the full count for an empty bundled set", async () => {
    expect(await pendingMigrationCount(opts(routed(), []))).toBe(4);
  });

  it("reads the bundled set from process.env.AGENCY_BOARD_MIGRATIONS (comma list) by default", async () => {
    const saved = process.env.AGENCY_BOARD_MIGRATIONS;
    try {
      process.env.AGENCY_BOARD_MIGRATIONS = "20261007000003, 20261008000006,20261013000007";
      expect(await pendingMigrationCount({ tag: "v1.2.0", fetch: routed().fn })).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.AGENCY_BOARD_MIGRATIONS;
      else process.env.AGENCY_BOARD_MIGRATIONS = saved;
    }
  });

  it("is null (unknown) when the bundled set is not available, without any fetch", async () => {
    const saved = process.env.AGENCY_BOARD_MIGRATIONS;
    try {
      delete process.env.AGENCY_BOARD_MIGRATIONS;
      const f = routed();
      expect(await pendingMigrationCount({ tag: "v1.2.0", fetch: f.fn })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.AGENCY_BOARD_MIGRATIONS = saved;
    }
  });

  it.each([404, 500])("is null (unknown) when the tag cannot be resolved (HTTP %i), and never falls back to the default branch", async (st) => {
    const f = routed(st);
    expect(await pendingMigrationCount(opts(f, []))).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("is null (unknown) when the tag's migrations cannot be listed", async () => {
    const f = fakeFetch((url) => (url === REF_URL("v1.2.0") ? json(refBody("v1.2.0", COMMIT_SHA, "commit")) : json({ message: "x" }, 500)));
    expect(await pendingMigrationCount(opts(f as never, []))).toBeNull();
  });
});
