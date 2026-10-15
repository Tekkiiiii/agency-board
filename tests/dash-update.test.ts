// In-app Update button, UI half: the dashboard banner (static markup) and syncUpdateAction (server action).
// No network, no DB: GitHub is a stubbed global fetch, db() is a mock so the rate limit never leaves rows behind.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { inspect } from "node:util";

const order: string[] = [];
const requireAdmin = vi.fn(async () => {
  order.push("requireAdmin");
  return { email: "admin@test.invalid" };
});
const logAdminAction = vi.fn(async (_name: string, _status: number) => {});
const revalidatePath = vi.fn();
const rpc = vi.fn(async (_fn: string, _args: Record<string, unknown>): Promise<{ data: unknown; error: unknown }> => {
  order.push("rpc");
  return { data: true, error: null };
});
let reqHeaders = new Headers({ host: "board.example.test" });
const headersFn = vi.fn(async () => {
  order.push("headers");
  return reqHeaders;
});

vi.mock("../lib/dash/session", () => ({ requireAdmin: () => requireAdmin() }));
vi.mock("../lib/dash/log", () => ({ logAdminAction: (n: string, s: number) => logAdminAction(n, s) }));
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("next/headers", () => ({ headers: () => headersFn() }));
vi.mock("../lib/db", () => ({ db: () => ({ rpc: (fn: string, args: Record<string, unknown>) => rpc(fn, args) }) }));

import { DEFAULT_UPSTREAM } from "../lib/update/config";
import { __resetCacheForTests } from "../lib/update/release";
import { SYNC_OK_MESSAGE, syncUpToDateMessage } from "../lib/update/sync";
import type { UpdateStatus } from "../lib/update/status";
import { UpdateBanner } from "../app/dashboard/_components/UpdateBanner";
import { syncUpdateAction } from "../app/dashboard/update/actions";

const TOKEN = "fake-test-token-0000";
const UP = DEFAULT_UPSTREAM;
const FORK = "me/my-board";
const TAG_SHA = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
const MOVED_SHA = "9999999999999999999999999999999999999999";
const MOVED_MESSAGE = "The release changed since you opened this page; reload and review it again";
const BAD_SHA_MESSAGE = "The release to apply is missing or invalid. Reload the page and try again.";

// ---------------- banner ----------------

const AVAILABLE: Extract<UpdateStatus, { state: "available" }> = {
  state: "available",
  latest: "1.2.0",
  tag: "v1.2.0",
  current: "1.1.0",
  notes: "Adds the update button.\nFixes a typo.",
  url: `https://github.com/${UP}/releases/tag/v1.2.0`,
  migrations: 2,
  sha: TAG_SHA,
  fork: FORK,
  manualSyncUrl: `https://github.com/${FORK}/compare/main...${UP.split("/")[0]}:v1.2.0`,
};
const SETUP: Extract<UpdateStatus, { state: "setup" }> = {
  state: "setup",
  latest: "1.2.0",
  tag: "v1.2.0",
  current: "1.1.0",
  url: AVAILABLE.url,
  manualSyncUrl: AVAILABLE.manualSyncUrl,
};
const render = (status: UpdateStatus) => renderToStaticMarkup(createElement(UpdateBanner, { status }));

describe("UpdateBanner", () => {
  it("hidden renders nothing at all (no DOM node)", () => {
    expect(render({ state: "hidden" })).toBe("");
  });

  it("available: heading, Update button, notes in <details>, migration count, release link", () => {
    const html = render(AVAILABLE);
    expect(html).toContain("Update available: v1.1.0 to v1.2.0");
    expect(html).toMatch(/role="region"/);
    expect(html).toMatch(/aria-label="[^"]*[Uu]pdate[^"]*"/);
    expect(html).toContain("<details");
    expect(html).toContain("Adds the update button.");
    expect(html).toContain("2 database migrations will apply during the build");
    expect(html).toContain(`href="${AVAILABLE.url}"`);
    const link = html.match(/<a [^>]*href="[^"]*releases\/tag[^"]*"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('rel="noopener noreferrer"');
    expect(link).toContain('target="_blank"');
    // trigger button + the confirm dialog restating version, migrations and what happens
    expect(html).toMatch(/<button[^>]*>\s*Update\s*<\/button>/);
    expect(html).toContain("Update now");
    expect(html).toContain("This syncs your fork on GitHub; Vercel then redeploys");
    expect(html).toContain("v1.2.0");
  });

  it("available: the confirm form carries the shown release commit as a hidden expectedSha field", () => {
    const html = render(AVAILABLE);
    expect(html).toMatch(new RegExp(`<input[^>]*type="hidden"[^>]*name="expectedSha"[^>]*value="${TAG_SHA}"|<input[^>]*name="expectedSha"[^>]*value="${TAG_SHA}"[^>]*type="hidden"`));
    expect(html.match(/name="expectedSha"/g)).toHaveLength(1);
  });

  it("available but the release commit is unknown (sha null): no Update button, no form field, manual links stay", () => {
    const html = render({ ...AVAILABLE, sha: null });
    expect(html).not.toContain("expectedSha");
    expect(html).not.toContain("<dialog");
    expect(html).not.toMatch(/<button[^>]*>\s*Update\s*<\/button>/);
    expect(html).toContain("Sync manually instead");
    expect(html).toContain("Update available: v1.1.0 to v1.2.0");
  });

  it("migration line: singular, and unknown when the count is null", () => {
    expect(render({ ...AVAILABLE, migrations: 1 })).toContain("1 database migration will apply during the build");
    expect(render({ ...AVAILABLE, migrations: null })).toMatch(/pending migration count unknown/i);
  });

  it("release notes are plain text: <script> and <img onerror> come out escaped", () => {
    const notes = '<script>alert(1)</script>\n<img src=x onerror="alert(2)">\n[link](javascript:alert(3))';
    const html = render({ ...AVAILABLE, notes });
    // (React itself appends one form-replay <script> when a <form action> is rendered; only the notes' markup matters here)
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<a href=\"javascript:");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=");
  });

  it("never injects raw HTML (banner and action sources)", () => {
    const banned = "dangerously" + "SetInnerHTML";
    for (const f of ["app/dashboard/_components/UpdateBanner.tsx", "app/dashboard/update/actions.ts"]) {
      expect(readFileSync(f, "utf8")).not.toContain(banned);
    }
  });

  it("setup: hint with the manual sync link and NO button, no dialog", () => {
    const html = render(SETUP);
    expect(html).toContain(
      "v1.2.0 is available. To enable one-click updates, set AGENCY_BOARD_GITHUB_TOKEN (README, Updating), or sync your fork manually.",
    );
    expect(html).toContain(`href="${SETUP.manualSyncUrl}"`);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<dialog");
    expect(html).toMatch(/role="region"/);
    const link = html.match(/<a [^>]*>/g)?.find((a) => a.includes(SETUP.manualSyncUrl)) ?? "";
    expect(link).toContain('rel="noopener noreferrer"');
  });
});

// ---------------- server action ----------------

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];
let syncStatus = 201;
let syncBody = "";
let refStatus = 200;
let tagMovesAfterFirstLookup = false;
let refLookups = 0;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function stubGithub() {
  calls = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.includes("/releases/latest")) {
      return json({
        tag_name: "v1.2.0",
        name: "Release 1.2.0",
        body: "Notes",
        html_url: `https://github.com/${UP}/releases/tag/v1.2.0`,
        published_at: "2026-10-01T00:00:00Z",
        draft: false,
        prerelease: false,
      });
    }
    if (url.includes("/git/ref/tags/")) {
      refLookups += 1;
      if (refStatus !== 200) return json({ message: "Not Found" }, refStatus);
      const sha = tagMovesAfterFirstLookup && refLookups > 1 ? MOVED_SHA : TAG_SHA;
      return json({ ref: "refs/tags/v1.2.0", object: { sha, type: "commit" } });
    }
    if (url.includes("/contents/supabase/migrations")) return json([{ name: "20261020000008_x.sql", type: "file" }]);
    if (url.endsWith("/merges") && init?.method === "POST") {
      const body = syncBody || JSON.stringify({ message: `echo ${TOKEN}` });
      return new Response(syncStatus === 204 ? null : body, { status: syncStatus });
    }
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const syncCalls = () => calls.filter((c) => c.url.endsWith("/merges") && c.init.method === "POST");

function form(m: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(m)) fd.set(k, v);
  return fd;
}
// What the banner's confirm form submits: the release commit the admin was shown.
const go = (sha: string = TAG_SHA) => syncUpdateAction(form({ expectedSha: sha }));

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
  order.length = 0;
  requireAdmin.mockClear();
  logAdminAction.mockClear();
  revalidatePath.mockClear();
  rpc.mockClear();
  rpc.mockImplementation(async () => {
    order.push("rpc");
    return { data: true, error: null };
  });
  headersFn.mockClear();
  reqHeaders = new Headers({ host: "board.example.test", origin: "https://board.example.test", "sec-fetch-site": "same-origin" });
  syncStatus = 201;
  syncBody = "";
  refStatus = 200;
  tagMovesAfterFirstLookup = false;
  refLookups = 0;
  vi.stubEnv("AGENCY_BOARD_VERSION", "1.1.0");
  vi.stubEnv("AGENCY_BOARD_MIGRATIONS", "");
  vi.stubEnv("AGENCY_BOARD_GITHUB_TOKEN", TOKEN);
  vi.stubEnv("AGENCY_BOARD_FORK", FORK);
  vi.stubEnv("AGENCY_BOARD_UPDATE_BRANCH", "");
  vi.stubEnv("AGENCY_BOARD_UPSTREAM", "");
  stubGithub();
  for (const s of Object.values(spies)) s.mockReset().mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const s of Object.values(spies)) s.mockReset();
});

describe("syncUpdateAction: auth and request checks", () => {
  it("requireAdmin runs first, before headers, the rate limit or GitHub", async () => {
    await go();
    expect(order[0]).toBe("requireAdmin");
    expect(order.indexOf("requireAdmin")).toBeLessThan(order.indexOf("rpc"));
  });

  it("a rejecting requireAdmin (redirect) stops everything: no DB, no GitHub, no audit", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(go()).rejects.toThrow("NEXT_REDIRECT");
    expect(rpc).not.toHaveBeenCalled();
    expect(headersFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("cross-origin Origin header is rejected without touching the rate limit or GitHub", async () => {
    reqHeaders = new Headers({ host: "board.example.test", origin: "https://evil.example" });
    const r = await go();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 403);
  });

  it("an opaque Origin ('null') is rejected", async () => {
    reqHeaders = new Headers({ host: "board.example.test", origin: "null" });
    expect((await go()).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("Sec-Fetch-Site cross-site / same-site is rejected", async () => {
    for (const site of ["cross-site", "same-site"]) {
      reqHeaders = new Headers({ host: "board.example.test", "sec-fetch-site": site });
      expect((await go()).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("same-origin works behind a proxy (x-forwarded-host wins over host, like Next)", async () => {
    reqHeaders = new Headers({ host: "internal:3000", "x-forwarded-host": "board.example.test", origin: "https://board.example.test" });
    expect((await go()).ok).toBe(true);
  });
});

describe("syncUpdateAction: rate limit", () => {
  it("uses hub_rate_hit with the exact key, window and max", async () => {
    await go();
    expect(rpc).toHaveBeenCalledWith("hub_rate_hit", { p_key: "dash:update-sync", p_window_seconds: 60, p_max: 3 });
  });

  it("limit exceeded (false) -> ok:false, GitHub never called", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const r = await go();
    expect(r).toEqual({ ok: false, message: "Too many attempts, wait a minute" });
    expect(calls).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 429);
  });

  it("RPC error fails CLOSED -> ok:false, GitHub never called", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    const r = await go();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a thrown RPC also fails closed", async () => {
    rpc.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await go();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("syncUpdateAction: re-derives the decision server side", () => {
  it("status not available (no newer release) -> ok:false without merging", async () => {
    vi.stubEnv("AGENCY_BOARD_VERSION", "1.2.0");
    const r = await go();
    expect(r.ok).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });

  it("status setup (no token) -> ok:false without merging", async () => {
    vi.stubEnv("AGENCY_BOARD_GITHUB_TOKEN", "");
    const r = await go();
    expect(r.ok).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });

  it("status hidden (GitHub unreachable) -> ok:false without merging", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)));
    const r = await go();
    expect(r.ok).toBe(false);
  });
});

describe("syncUpdateAction: success path", () => {
  it("syncs the env fork/branch with the env token, audits 200, revalidates the layout", async () => {
    vi.stubEnv("AGENCY_BOARD_UPDATE_BRANCH", "release");
    const r = await go();
    expect(r).toEqual({ ok: true, message: SYNC_OK_MESSAGE });
    const s = syncCalls();
    expect(s).toHaveLength(1);
    expect(s[0].url).toBe(`https://api.github.com/repos/${FORK}/merges`);
    expect(s[0].init.method).toBe("POST");
    expect(JSON.parse(String(s[0].init.body))).toEqual({ base: "release", head: TAG_SHA, commit_message: "Update to v1.2.0" });
    expect(calls.some((c) => c.url.includes("merge-upstream"))).toBe(false);
    expect((s[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 200);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });

  it("ignores every FormData value (fork, repo, owner, branch, token, url)", async () => {
    const r = await syncUpdateAction(
      form({
        expectedSha: TAG_SHA,
        fork: "attacker/evil",
        repo: "evil",
        owner: "attacker",
        branch: "evil-branch",
        token: "attacker-token-9999",
        url: "https://evil.example/hook",
      }),
    );
    expect(r.ok).toBe(true);
    const s = syncCalls();
    expect(s).toHaveLength(1);
    expect(s[0].url).toBe(`https://api.github.com/repos/${FORK}/merges`);
    expect(JSON.parse(String(s[0].init.body))).toEqual({ base: "main", head: TAG_SHA, commit_message: "Update to v1.2.0" });
    const hdr = s[0].init.headers as Record<string, string>;
    expect(hdr.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls)).not.toMatch(/attacker|evil/);
  });
});

describe("syncUpdateAction: tag handling", () => {
  it("tag moved after the banner was rendered (fresh lookup differs from the shown sha) -> refused, NO merge call", async () => {
    tagMovesAfterFirstLookup = true; // 1st lookup (status, cached) = TAG_SHA, 2nd (sync, fresh) = MOVED_SHA
    const r = await go(TAG_SHA);
    expect(r).toEqual({ ok: false, message: MOVED_MESSAGE });
    expect(syncCalls()).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 412);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("already contains the tag (204) -> ok:true with the up-to-date message, audited 200, layout revalidated", async () => {
    syncStatus = 204;
    const r = await go();
    expect(r).toEqual({ ok: true, message: syncUpToDateMessage("v1.2.0") });
    expect(r.message).not.toBe(SYNC_OK_MESSAGE);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 200);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });
});

describe("syncUpdateAction: failures map to fixed messages and leak nothing", () => {
  it("409 -> merge conflict message, audited 409", async () => {
    syncStatus = 409;
    const r = await go();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/merge conflict/i);
    expect(r.message).toMatch(/manual sync/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 409);
    expect(revalidatePath).not.toHaveBeenCalledWith("/dashboard", "layout");
  });

  it("422 -> unreachable message (manual sync link), audited 422", async () => {
    syncStatus = 422;
    const r = await go();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not merge the release commit/i);
    expect(r.message).toMatch(/manual sync link/i);
    expect(r.message).not.toMatch(/diverged/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 422);
  });

  it("404 'Head does not exist' -> unreachable message, audited 422", async () => {
    syncStatus = 404;
    syncBody = JSON.stringify({ message: "Head does not exist" });
    const r = await go();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not merge the release commit/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 422);
  });

  it("404 on the merge (base/fork missing) -> not found message, audited 404", async () => {
    syncStatus = 404;
    syncBody = JSON.stringify({ message: "Base does not exist" });
    const r = await go();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/fork or the branch/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 404);
  });

  it("release tag gone at sync time -> tag_not_found message, audited 404, no merge call", async () => {
    // The status check tolerates an unresolvable tag (migrations unknown); the sync resolves it fresh and refuses.
    refStatus = 404;
    const r = await go();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/release tag was not found/i);
    expect(syncCalls()).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 404);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("401 / 404 / 500 are ok:false with fixed text", async () => {
    for (const st of [401, 404, 500]) {
      syncStatus = st;
      const r = await go();
      expect(r.ok).toBe(false);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });

  it("the token never appears in any result, console output or audit call (GitHub echoing it back included)", async () => {
    const results: unknown[] = [];
    for (const st of [201, 204, 401, 403, 404, 409, 422, 429, 500]) {
      syncStatus = st;
      syncBody = JSON.stringify({ message: `Bad credentials ${TOKEN}`, token: TOKEN });
      results.push(await go());
    }
    // rate-limit and RPC-error branches too
    rpc.mockResolvedValueOnce({ data: false, error: null });
    results.push(await go());
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: `leak ${TOKEN}` } });
    results.push(await go());
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
    expect(JSON.stringify(logAdminAction.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(revalidatePath.mock.calls)).not.toContain(TOKEN);
  });
});

describe("syncUpdateAction: expectedSha (F2)", () => {
  it("match: the shown sha equals the fresh tag commit -> merges that commit, audited 200", async () => {
    const r = await go(TAG_SHA);
    expect(r).toEqual({ ok: true, message: SYNC_OK_MESSAGE });
    const s = syncCalls();
    expect(s).toHaveLength(1);
    expect(JSON.parse(String(s[0].init.body)).head).toBe(TAG_SHA);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 200);
  });

  it("mismatch: a well-formed sha that is not the fresh tag commit is refused with the fixed message and NO merge call", async () => {
    const r = await go(MOVED_SHA);
    expect(r).toEqual({ ok: false, message: MOVED_MESSAGE });
    expect(syncCalls()).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 412); // tag_moved has its own audit code, distinct from a merge conflict (409)
    expect(logAdminAction).not.toHaveBeenCalledWith("update_sync", 409);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("success logs the merged tag and the sha that was actually merged (the fresh lookup), never the token", async () => {
    tagMovesAfterFirstLookup = true; // fresh lookup returns MOVED_SHA
    const r = await go(MOVED_SHA);
    expect(r.ok).toBe(true);
    const text = consoleText();
    expect(text).toContain("update sync merged");
    expect(text).toContain("v1.2.0");
    expect(text).toContain(MOVED_SHA);
    expect(text).not.toContain(TOKEN);
  });

  it("the submitted sha only narrows: the merge head is the server-resolved sha, not the form value", async () => {
    tagMovesAfterFirstLookup = true; // fresh lookup returns MOVED_SHA
    const r = await go(MOVED_SHA); // the client claims the moved sha: it equals the fresh one, so it merges the fresh one
    expect(r.ok).toBe(true);
    expect(JSON.parse(String(syncCalls()[0].init.body)).head).toBe(MOVED_SHA);
    // and the fresh sha is fetched from GitHub, never copied from the form: a sha GitHub never returned cannot reach the merge
    tagMovesAfterFirstLookup = false;
    refLookups = 0;
    calls = [];
    const r2 = await go("a".repeat(40));
    expect(r2.ok).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });

  it("malformed sha: refused with the fixed message, no merge call, nothing echoed", async () => {
    const bad = [
      "",
      "abc",
      TAG_SHA.toUpperCase(),
      TAG_SHA.slice(1),
      `${TAG_SHA}0`,
      "g".repeat(40),
      ` ${TAG_SHA}`,
      `${TAG_SHA} `,
      `${TAG_SHA}\n`,
      `${TAG_SHA}\n${TAG_SHA}`,
      "../".repeat(14),
      "<script>alert(1)</script>",
    ];
    for (const b of bad) {
      const r = await go(b);
      expect(r).toEqual({ ok: false, message: BAD_SHA_MESSAGE });
      expect(r.message).not.toContain(b.trim() || "\u0000");
    }
    expect(syncCalls()).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("missing sha (no FormData, empty FormData, a file instead of a string): refused, no merge call", async () => {
    const withFile = new FormData();
    withFile.set("expectedSha", new File(["x"], "sha.txt"));
    for (const fd of [undefined, form({}), form({ expectedSHA: TAG_SHA, sha: TAG_SHA }), withFile]) {
      expect(await syncUpdateAction(fd)).toEqual({ ok: false, message: BAD_SHA_MESSAGE });
    }
    expect(syncCalls()).toHaveLength(0);
  });

  it("the sha check sits after the existing gates: rate limit and origin still win, and requireAdmin is still first", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    expect(await go("not-a-sha")).toEqual({ ok: false, message: "Too many attempts, wait a minute" });
    reqHeaders = new Headers({ host: "board.example.test", origin: "https://evil.example" });
    expect((await go("not-a-sha")).message).toMatch(/request rejected/i);
    expect(order[0]).toBe("requireAdmin");
  });

  it("logs the merged tag and commit on success (F3), without the token", async () => {
    await go(TAG_SHA);
    const out = consoleText();
    expect(out).toContain("v1.2.0");
    expect(out).toContain(TAG_SHA);
    expect(out).not.toContain(TOKEN);
  });

  it("logs no merged line when nothing was merged (204 up to date, moved tag, malformed sha)", async () => {
    syncStatus = 204;
    await go(TAG_SHA);
    await go(MOVED_SHA);
    await go("nope");
    expect(consoleText()).not.toContain("merged");
  });
});
