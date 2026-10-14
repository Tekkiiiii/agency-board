// In-app Update button: upstream release lookup + migration-count lookup (unauthenticated, cached, shape-validated).
// A fake fetch is injected everywhere: no network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { DEFAULT_UPSTREAM } from "../lib/update/config";
import { fetchLatestRelease, fetchMigrationVersions, pendingMigrationCount, __resetCacheForTests } from "../lib/update/release";

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

const MIG_URL = `https://api.github.com/repos/${UP}/contents/supabase/migrations`;
const files = (...names: string[]) => names.map((name) => ({ name, type: "file", path: `supabase/migrations/${name}`, download_url: "https://evil.example/x" }));

describe("fetchMigrationVersions", () => {
  it("GETs the contents API with no ref (upstream default branch head), unauthenticated, and returns sorted 14-digit versions", async () => {
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
    const v = await fetchMigrationVersions({ fetch: f.fn, env: { AGENCY_BOARD_GITHUB_TOKEN: TOKEN } });
    expect(v).toEqual(["20261007000003", "20261008000006"]);
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0];
    expect(url).toBe(MIG_URL);
    expect(url).not.toContain("ref=");
    expect(url).not.toContain("?");
    expect(url.startsWith("https://api.github.com/")).toBe(true);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
    expect(f.calls.map((c) => c.url).some((u) => u.includes("evil"))).toBe(false);
  });

  it("dedupes versions", async () => {
    const f = fakeFetch(() => json(files("20261007000003_a.sql", "20261007000003_b.sql")));
    expect(await fetchMigrationVersions({ fetch: f.fn })).toEqual(["20261007000003"]);
  });

  it.each([
    ["an object", { message: "Not Found" }],
    ["a string", "x"],
    ["html", "<html>"],
  ])("returns null for %s", async (_l, payload) => {
    const f = fakeFetch(() => json(payload as never));
    expect(await fetchMigrationVersions({ fetch: f.fn })).toBeNull();
  });

  it.each([403, 404, 500])("returns null for HTTP %i and negative-caches it", async (status) => {
    const f = fakeFetch(() => json([], status));
    expect(await fetchMigrationVersions({ fetch: f.fn, now: () => 0 })).toBeNull();
    expect(await fetchMigrationVersions({ fetch: f.fn, now: () => 1000 })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it("caches per upstream (key migrations:<upstream>:head) for the TTL", async () => {
    let t = 0;
    const f = fakeFetch(() => json(files("20261007000003_a.sql")));
    const opts = { fetch: f.fn, now: () => t };
    await fetchMigrationVersions(opts);
    await fetchMigrationVersions(opts);
    expect(f.calls).toHaveLength(1);
    await fetchMigrationVersions({ ...opts, env: { AGENCY_BOARD_UPSTREAM: "someorg/other-board" } });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].url).toBe("https://api.github.com/repos/someorg/other-board/contents/supabase/migrations");
    t = 60 * 60 * 1000 + 1;
    await fetchMigrationVersions(opts);
    expect(f.calls).toHaveLength(3);
  });

  it("never throws on a network error", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("down");
    });
    await expect(fetchMigrationVersions({ fetch: f.fn })).resolves.toBeNull();
  });
});

describe("pendingMigrationCount", () => {
  const upstream = files("20261007000003_a.sql", "20261008000006_b.sql", "20261013000007_c.sql", "20261020000008_d.sql");

  it("counts upstream versions that are not in the bundled set", async () => {
    const f = fakeFetch(() => json(upstream));
    const n = await pendingMigrationCount({ fetch: f.fn, bundled: ["20261007000003", "20261008000006", "20261013000007"] });
    expect(n).toBe(1);
  });

  it("is 0 when everything is bundled, and ignores bundled versions upstream no longer has", async () => {
    const f = fakeFetch(() => json(upstream));
    const all = ["20261007000003", "20261008000006", "20261013000007", "20261020000008", "20250101000000"];
    expect(await pendingMigrationCount({ fetch: f.fn, bundled: all })).toBe(0);
  });

  it("is the full upstream count for an empty bundled set", async () => {
    const f = fakeFetch(() => json(upstream));
    expect(await pendingMigrationCount({ fetch: f.fn, bundled: [] })).toBe(4);
  });

  it("reads the bundled set from process.env.AGENCY_BOARD_MIGRATIONS (comma list) by default", async () => {
    const saved = process.env.AGENCY_BOARD_MIGRATIONS;
    try {
      process.env.AGENCY_BOARD_MIGRATIONS = "20261007000003, 20261008000006,20261013000007";
      const f = fakeFetch(() => json(upstream));
      expect(await pendingMigrationCount({ fetch: f.fn })).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.AGENCY_BOARD_MIGRATIONS;
      else process.env.AGENCY_BOARD_MIGRATIONS = saved;
    }
  });

  it("is null (unknown) when the bundled set is not available", async () => {
    const saved = process.env.AGENCY_BOARD_MIGRATIONS;
    try {
      delete process.env.AGENCY_BOARD_MIGRATIONS;
      const f = fakeFetch(() => json(upstream));
      expect(await pendingMigrationCount({ fetch: f.fn })).toBeNull();
    } finally {
      if (saved !== undefined) process.env.AGENCY_BOARD_MIGRATIONS = saved;
    }
  });

  it("is null (unknown) when upstream cannot be listed", async () => {
    const f = fakeFetch(() => json({ message: "x" }, 500));
    expect(await pendingMigrationCount({ fetch: f.fn, bundled: [] })).toBeNull();
  });
});
