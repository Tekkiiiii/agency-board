// In-app Update button: the hidden / setup / available decision. Fake fetch + injected env, no network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import { DEFAULT_UPSTREAM } from "../lib/update/config";
import { getUpdateStatus, getUpdateStatusWithin } from "../lib/update/status";
import { __resetCacheForTests } from "../lib/update/release";

const TOKEN = "fake-test-token-0000";
const UP = DEFAULT_UPSTREAM;
const UP_OWNER = UP.split("/")[0];
const FORK = "me/my-board";

const TAG_SHA = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
const refUrl = (tag = "v1.2.0") => `https://api.github.com/repos/${UP}/git/ref/tags/${tag}`;
const migUrl = (sha = TAG_SHA) => `https://api.github.com/repos/${UP}/contents/supabase/migrations?ref=${sha}`;

const MIGS_UP = ["20261007000003", "20261008000006", "20261013000007", "20261020000008"];
const MIGS_BUNDLED = "20261007000003,20261008000006,20261013000007";

type Handler = (url: string) => Response;
function fakeFetch(handler: Handler) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input));
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response([101, 204, 205, 304].includes(status) ? null : typeof body === "string" ? body : JSON.stringify(body), { status });

function releaseBody(over: Record<string, unknown> = {}) {
  return {
    tag_name: "v1.2.0",
    name: "Release 1.2.0",
    body: "Notes: new stuff",
    html_url: `https://github.com/${UP}/releases/tag/v1.2.0`,
    published_at: "2026-10-01T00:00:00Z",
    draft: false,
    prerelease: false,
    ...over,
  };
}
function happy(over: Record<string, unknown> = {}, migrations: string[] = MIGS_UP) {
  return fakeFetch((url) => {
    if (url.includes("/releases/latest")) return json(releaseBody(over));
    const m = url.match(/\/git\/ref\/tags\/(.+)$/);
    if (m) return json({ ref: `refs/tags/${m[1]}`, object: { sha: TAG_SHA, type: "commit" } });
    if (url.includes("/contents/supabase/migrations")) {
      // Only the tag's tree is answered; a default-branch listing (no ?ref=) gets a different, wrong list.
      if (!url.endsWith(`?ref=${TAG_SHA}`)) return json([{ name: "20269999000000_default_branch_only.sql", type: "file" }]);
      return json(migrations.map((v) => ({ name: `${v}_x.sql`, type: "file" })));
    }
    return json({}, 404);
  });
}

const ENV_OK = { AGENCY_BOARD_GITHUB_TOKEN: TOKEN, AGENCY_BOARD_FORK: FORK };
const base = { runningVersion: "1.1.0", bundledMigrations: MIGS_BUNDLED.split(",") };

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

describe("getUpdateStatus: available", () => {
  it("returns the full available shape when a newer release exists and sync is configured", async () => {
    const f = happy();
    const s = await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK });
    expect(s).toEqual({
      state: "available",
      latest: "1.2.0",
      tag: "v1.2.0",
      current: "1.1.0",
      notes: "Notes: new stuff",
      url: `https://github.com/${UP}/releases/tag/v1.2.0`,
      migrations: 1,
      sha: TAG_SHA,
      fork: FORK,
      manualSyncUrl: `https://github.com/${FORK}/compare/main...${UP_OWNER}:v1.2.0`,
    });
    expect(f.calls.map((c) => c.url)).toEqual([`https://api.github.com/repos/${UP}/releases/latest`, refUrl(), migUrl()]);
  });

  it("counts migrations on the release TAG's tree (contents?ref=<tag sha>), not the default branch", async () => {
    const f = happy();
    await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK });
    const mig = f.calls.map((c) => c.url).filter((u) => u.includes("/contents/"));
    expect(mig).toEqual([migUrl()]);
    expect(mig[0]).not.toMatch(/migrations$/);
  });

  it("reports migrations:null (unknown) when the release tag cannot be resolved, and does not fall back to the default branch", async () => {
    const f = fakeFetch((url) =>
      url.includes("/releases/latest") ? json(releaseBody()) : url.includes("/git/ref/tags/") ? json({ message: "Not Found" }, 404) : json([{ name: "20261020000008_x.sql", type: "file" }]),
    );
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK })).toMatchObject({ state: "available", tag: "v1.2.0", migrations: null });
    expect(f.calls.some((c) => c.url.includes("/contents/"))).toBe(false);
  });

  it("uses the configured branch in the manual sync link", async () => {
    const s = await getUpdateStatus({ ...base, fetch: happy().fn, env: { ...ENV_OK, AGENCY_BOARD_UPDATE_BRANCH: "release/1.x" } });
    expect(s).toMatchObject({ state: "available", manualSyncUrl: `https://github.com/${FORK}/compare/release/1.x...${UP_OWNER}:v1.2.0` });
  });

  it("resolves the fork from the Vercel system env", async () => {
    const env = { AGENCY_BOARD_GITHUB_TOKEN: TOKEN, VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "my-board" };
    expect(await getUpdateStatus({ ...base, fetch: happy().fn, env })).toMatchObject({ state: "available", fork: FORK });
  });

  it("reports migrations:null (unknown) when the upstream migration list cannot be read", async () => {
    const f = fakeFetch((url) => (url.includes("/releases/latest") ? json(releaseBody()) : json({ message: "x" }, 500)));
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK })).toMatchObject({ state: "available", migrations: null });
  });

  it("carries the release commit the banner shows (sha), even when the migration count is unknown", async () => {
    const s = await getUpdateStatus({ runningVersion: "1.1.0", bundledMigrations: null, fetch: happy().fn, env: ENV_OK });
    expect(s).toMatchObject({ state: "available", migrations: null, sha: TAG_SHA });
  });

  it("reports sha:null when the release tag cannot be resolved (the banner then offers no Update button)", async () => {
    const f = fakeFetch((url) =>
      url.includes("/releases/latest") ? json(releaseBody()) : url.includes("/git/ref/tags/") ? json({ message: "Not Found" }, 404) : json([]),
    );
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK })).toMatchObject({ state: "available", sha: null });
  });

  it("reports migrations:null when the running app has no bundled migration list", async () => {
    const s = await getUpdateStatus({ runningVersion: "1.1.0", bundledMigrations: null, fetch: happy().fn, env: ENV_OK });
    expect(s).toMatchObject({ state: "available", migrations: null });
  });

  it("reports migrations:0 when nothing is pending", async () => {
    const s = await getUpdateStatus({ ...base, fetch: happy({}, MIGS_BUNDLED.split(",")).fn, env: ENV_OK });
    expect(s).toMatchObject({ state: "available", migrations: 0 });
  });

  it("treats a release as newer than the running prerelease of the same version", async () => {
    const s = await getUpdateStatus({ ...base, runningVersion: "v1.2.0-rc.1", fetch: happy().fn, env: ENV_OK });
    expect(s).toMatchObject({ state: "available", current: "1.2.0-rc.1", latest: "1.2.0" });
  });

  it("compares numerically (1.10.0 is newer than 1.9.0)", async () => {
    const f = happy({ tag_name: "v1.10.0", html_url: `https://github.com/${UP}/releases/tag/v1.10.0` });
    expect(await getUpdateStatus({ ...base, runningVersion: "1.9.0", fetch: f.fn, env: ENV_OK })).toMatchObject({ state: "available", latest: "1.10.0", tag: "v1.10.0" });
  });

  it("never leaks the token into the result or the console", async () => {
    const s = await getUpdateStatus({ ...base, fetch: happy().fn, env: ENV_OK });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
  });
});

describe("getUpdateStatus: setup", () => {
  it("is setup when the token is missing (fork known)", async () => {
    const f = happy();
    const s = await getUpdateStatus({ ...base, fetch: f.fn, env: { AGENCY_BOARD_FORK: FORK } });
    expect(s).toEqual({
      state: "setup",
      latest: "1.2.0",
      tag: "v1.2.0",
      current: "1.1.0",
      url: `https://github.com/${UP}/releases/tag/v1.2.0`,
      manualSyncUrl: `https://github.com/${FORK}/compare/main...${UP_OWNER}:v1.2.0`,
    });
    expect(f.calls).toHaveLength(1); // no tag or migration lookup for the hint
  });

  it("is setup when the token is only whitespace", async () => {
    const s = await getUpdateStatus({ ...base, fetch: happy().fn, env: { AGENCY_BOARD_FORK: FORK, AGENCY_BOARD_GITHUB_TOKEN: "  " } });
    expect(s.state).toBe("setup");
  });

  it("is setup when the fork cannot be resolved, with the upstream page as the manual link", async () => {
    const s = await getUpdateStatus({ ...base, fetch: happy().fn, env: { AGENCY_BOARD_GITHUB_TOKEN: TOKEN } });
    expect(s).toMatchObject({ state: "setup", tag: "v1.2.0", manualSyncUrl: `https://github.com/${UP}/releases/tag/v1.2.0` });
    expect(JSON.stringify(s)).not.toContain(TOKEN);
  });

  it("is setup when the fork override is invalid (never used to build a URL)", async () => {
    const f = happy();
    const s = await getUpdateStatus({ ...base, fetch: f.fn, env: { AGENCY_BOARD_GITHUB_TOKEN: TOKEN, AGENCY_BOARD_FORK: "a/b/../c" } });
    expect(s).toMatchObject({ state: "setup", manualSyncUrl: `https://github.com/${UP}/releases/tag/v1.2.0` });
    expect(JSON.stringify(s)).not.toContain("..");
  });

  it("is setup with neither token nor fork", async () => {
    expect((await getUpdateStatus({ ...base, fetch: happy().fn, env: {} })).state).toBe("setup");
  });
});

describe("getUpdateStatus: hidden", () => {
  it("is hidden when the running version equals the latest", async () => {
    expect(await getUpdateStatus({ ...base, runningVersion: "1.2.0", fetch: happy().fn, env: ENV_OK })).toEqual({ state: "hidden" });
    expect(await getUpdateStatus({ ...base, runningVersion: "v1.2.0", fetch: happy().fn, env: ENV_OK })).toEqual({ state: "hidden" });
  });

  it("is hidden when the running version is newer than the latest release", async () => {
    expect(await getUpdateStatus({ ...base, runningVersion: "1.3.0", fetch: happy().fn, env: ENV_OK })).toEqual({ state: "hidden" });
    expect(await getUpdateStatus({ ...base, runningVersion: "2.0.0-rc.1", fetch: happy().fn, env: ENV_OK })).toEqual({ state: "hidden" });
  });

  it("is hidden (also in setup conditions) when not newer", async () => {
    expect(await getUpdateStatus({ ...base, runningVersion: "1.2.0", fetch: happy().fn, env: {} })).toEqual({ state: "hidden" });
  });

  it.each(["", "   ", "garbage", "1.2", "latest"])("is hidden when the running version is unknown/invalid (%j)", async (rv) => {
    const f = happy();
    expect(await getUpdateStatus({ ...base, runningVersion: rv, fetch: f.fn, env: ENV_OK })).toEqual({ state: "hidden" });
  });

  it("reads the running version from process.env.AGENCY_BOARD_VERSION by default (missing => hidden)", async () => {
    const saved = process.env.AGENCY_BOARD_VERSION;
    try {
      delete process.env.AGENCY_BOARD_VERSION;
      expect(await getUpdateStatus({ fetch: happy().fn, env: ENV_OK })).toEqual({ state: "hidden" });
      process.env.AGENCY_BOARD_VERSION = "1.1.0";
      __resetCacheForTests();
      expect((await getUpdateStatus({ fetch: happy().fn, env: ENV_OK, bundledMigrations: [] })).state).toBe("available");
    } finally {
      if (saved === undefined) delete process.env.AGENCY_BOARD_VERSION;
      else process.env.AGENCY_BOARD_VERSION = saved;
    }
  });

  it("is hidden when fork === upstream, case-insensitively (not a fork, cannot sync)", async () => {
    for (const fork of [UP, UP.toLowerCase(), UP.toUpperCase()]) {
      expect(await getUpdateStatus({ ...base, fetch: happy().fn, env: { ...ENV_OK, AGENCY_BOARD_FORK: fork } })).toEqual({ state: "hidden" });
    }
    const env = { AGENCY_BOARD_GITHUB_TOKEN: TOKEN, VERCEL_GIT_REPO_OWNER: UP_OWNER.toLowerCase(), VERCEL_GIT_REPO_SLUG: UP.split("/")[1].toUpperCase() };
    expect(await getUpdateStatus({ ...base, fetch: happy().fn, env })).toEqual({ state: "hidden" });
  });

  it("is hidden when fork === a custom upstream, even without a token", async () => {
    const f = happy({ html_url: "https://github.com/my-org/board/releases/tag/v1.2.0" });
    const env = { AGENCY_BOARD_UPSTREAM: "my-org/board", AGENCY_BOARD_FORK: "my-org/board" };
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env })).toEqual({ state: "hidden" });
  });

  it("is hidden for an invalid upstream override, without any fetch", async () => {
    for (const bad of ["..", "owner/..", "a/b@evil", "a/b/../c", "https://evil.com/x/y", "a/b c"]) {
      const f = happy();
      expect(await getUpdateStatus({ ...base, fetch: f.fn, env: { ...ENV_OK, AGENCY_BOARD_UPSTREAM: bad } })).toEqual({ state: "hidden" });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("is hidden for an invalid branch override", async () => {
    const f = happy();
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: { ...ENV_OK, AGENCY_BOARD_UPDATE_BRANCH: "../x" } })).toEqual({ state: "hidden" });
  });

  it.each([404, 429, 500])("is hidden when the release lookup fails (HTTP %i)", async (status) => {
    const f = fakeFetch(() => json(releaseBody(), status));
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK })).toEqual({ state: "hidden" });
  });

  it("is hidden when the network fails or fetch throws synchronously", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("network down");
    });
    expect(await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK })).toEqual({ state: "hidden" });
    __resetCacheForTests();
    const sync = (() => {
      throw new Error("sync");
    }) as unknown as typeof fetch;
    expect(await getUpdateStatus({ ...base, fetch: sync, env: ENV_OK })).toEqual({ state: "hidden" });
  });

  it("is hidden on response-shape abuse (html_url elsewhere, draft, prerelease, non-string body, bad tag)", async () => {
    for (const over of [
      { html_url: "https://evil.com/x" },
      { draft: true },
      { prerelease: true },
      { body: 42 },
      { tag_name: "nightly" },
    ]) {
      __resetCacheForTests();
      expect(await getUpdateStatus({ ...base, fetch: happy(over).fn, env: ENV_OK })).toEqual({ state: "hidden" });
    }
  });

  it("never throws, even when the env object itself throws on access", async () => {
    const env = new Proxy({}, { get() { throw new Error(`boom ${TOKEN}`); } }) as Record<string, string | undefined>;
    await expect(getUpdateStatus({ ...base, fetch: happy().fn, env })).resolves.toEqual({ state: "hidden" });
    expect(consoleText()).not.toContain(TOKEN);
  });
});

describe("getUpdateStatus: caching and outbound hygiene", () => {
  it("makes one release fetch for repeated calls (hourly cache)", async () => {
    const f = happy();
    for (let i = 0; i < 6; i++) await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK });
    expect(f.calls.filter((c) => c.url.includes("/releases/latest"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.includes("/git/ref/tags/"))).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.includes("/contents/"))).toHaveLength(1);
  });

  it("only ever calls api.github.com, unauthenticated, with redirect:error", async () => {
    const f = happy();
    await getUpdateStatus({ ...base, fetch: f.fn, env: ENV_OK });
    for (const c of f.calls) {
      expect(c.url.startsWith("https://api.github.com/")).toBe(true);
      expect(c.init.redirect).toBe("error");
      expect(new Headers(c.init.headers).has("authorization")).toBe(false);
    }
    expect(JSON.stringify(f.calls)).not.toContain(TOKEN);
  });
});

describe("getUpdateStatusWithin: bounded first render", () => {
  function gatedFetch() {
    let open!: () => void;
    const gate = new Promise<void>((r) => {
      open = r;
    });
    const calls: string[] = [];
    const fn = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/releases/latest")) {
        await gate;
        return json(releaseBody());
      }
      if (url.includes("/git/ref/tags/")) return json({ ref: "refs/tags/v1.2.0", object: { sha: TAG_SHA, type: "commit" } });
      return json(MIGS_UP.map((v) => ({ name: `${v}_x.sql`, type: "file" })));
    }) as unknown as typeof fetch;
    return { fn, calls, open };
  }

  it("returns hidden within the bound while the lookup is still in flight, then the real status from cache", async () => {
    const g = gatedFetch();
    const deps = { ...base, fetch: g.fn, env: ENV_OK };
    const t0 = Date.now();
    expect(await getUpdateStatusWithin(25, deps)).toEqual({ state: "hidden" });
    expect(Date.now() - t0).toBeLessThan(1000);
    g.open(); // the in-flight lookup keeps going and warms the cache
    await vi.waitFor(async () => {
      expect(await getUpdateStatusWithin(1000, deps)).toMatchObject({ state: "available", latest: "1.2.0", migrations: 1 });
    });
    const releaseCalls = g.calls.filter((u) => u.includes("/releases/latest")).length;
    expect(releaseCalls).toBe(1); // later calls hit the cache, no second lookup
    expect(await getUpdateStatusWithin(1000, deps)).toMatchObject({ state: "available" });
    expect(g.calls.filter((u) => u.includes("/releases/latest"))).toHaveLength(1);
  });

  it("defaults to 1500 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const g = gatedFetch();
      let settled: unknown = null;
      const p = getUpdateStatusWithin(undefined, { ...base, fetch: g.fn, env: ENV_OK }).then((s) => (settled = s));
      await vi.advanceTimersByTimeAsync(1499);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(settled).toEqual({ state: "hidden" });
      g.open();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its timer when the lookup wins the race", async () => {
    const clear = vi.spyOn(globalThis, "clearTimeout");
    try {
      const s = await getUpdateStatusWithin(60_000, { ...base, fetch: happy().fn, env: ENV_OK });
      expect(s).toMatchObject({ state: "available" });
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });

  it("never throws: a failing lookup still resolves hidden", async () => {
    const boom = (async () => {
      throw new TypeError("down");
    }) as unknown as typeof fetch;
    await expect(getUpdateStatusWithin(1000, { ...base, fetch: boom, env: ENV_OK })).resolves.toEqual({ state: "hidden" });
  });
});
