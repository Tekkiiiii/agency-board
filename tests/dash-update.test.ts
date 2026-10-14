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
import { SYNC_OK_MESSAGE } from "../lib/update/sync";
import type { UpdateStatus } from "../lib/update/status";
import { UpdateBanner } from "../app/dashboard/_components/UpdateBanner";
import { syncUpdateAction } from "../app/dashboard/update/actions";

const TOKEN = "fake-test-token-0000";
const UP = DEFAULT_UPSTREAM;
const FORK = "me/my-board";

// ---------------- banner ----------------

const AVAILABLE: Extract<UpdateStatus, { state: "available" }> = {
  state: "available",
  latest: "1.2.0",
  current: "1.1.0",
  notes: "Adds the update button.\nFixes a typo.",
  url: `https://github.com/${UP}/releases/tag/v1.2.0`,
  migrations: 2,
  fork: FORK,
  manualSyncUrl: `https://github.com/${FORK}/compare/main...${UP.split("/")[0]}:main`,
};
const SETUP: Extract<UpdateStatus, { state: "setup" }> = {
  state: "setup",
  latest: "1.2.0",
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
let syncStatus = 200;
let syncBody = "";

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
    if (url.includes("/contents/supabase/migrations")) return json([{ name: "20261020000008_x.sql", type: "file" }]);
    if (url.endsWith("/merge-upstream")) return new Response(syncBody || JSON.stringify({ message: `echo ${TOKEN}` }), { status: syncStatus });
    return json({}, 404);
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
const syncCalls = () => calls.filter((c) => c.url.endsWith("/merge-upstream"));

function form(m: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(m)) fd.set(k, v);
  return fd;
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
  syncStatus = 200;
  syncBody = "";
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
    await syncUpdateAction();
    expect(order[0]).toBe("requireAdmin");
    expect(order.indexOf("requireAdmin")).toBeLessThan(order.indexOf("rpc"));
  });

  it("a rejecting requireAdmin (redirect) stops everything: no DB, no GitHub, no audit", async () => {
    requireAdmin.mockRejectedValueOnce(new Error("NEXT_REDIRECT"));
    await expect(syncUpdateAction()).rejects.toThrow("NEXT_REDIRECT");
    expect(rpc).not.toHaveBeenCalled();
    expect(headersFn).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(logAdminAction).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("cross-origin Origin header is rejected without touching the rate limit or GitHub", async () => {
    reqHeaders = new Headers({ host: "board.example.test", origin: "https://evil.example" });
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 403);
  });

  it("an opaque Origin ('null') is rejected", async () => {
    reqHeaders = new Headers({ host: "board.example.test", origin: "null" });
    expect((await syncUpdateAction()).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("Sec-Fetch-Site cross-site / same-site is rejected", async () => {
    for (const site of ["cross-site", "same-site"]) {
      reqHeaders = new Headers({ host: "board.example.test", "sec-fetch-site": site });
      expect((await syncUpdateAction()).ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("same-origin works behind a proxy (x-forwarded-host wins over host, like Next)", async () => {
    reqHeaders = new Headers({ host: "internal:3000", "x-forwarded-host": "board.example.test", origin: "https://board.example.test" });
    expect((await syncUpdateAction()).ok).toBe(true);
  });
});

describe("syncUpdateAction: rate limit", () => {
  it("uses hub_rate_hit with the exact key, window and max", async () => {
    await syncUpdateAction();
    expect(rpc).toHaveBeenCalledWith("hub_rate_hit", { p_key: "dash:update-sync", p_window_seconds: 60, p_max: 3 });
  });

  it("limit exceeded (false) -> ok:false, GitHub never called", async () => {
    rpc.mockResolvedValueOnce({ data: false, error: null });
    const r = await syncUpdateAction();
    expect(r).toEqual({ ok: false, message: "Too many attempts, wait a minute" });
    expect(calls).toHaveLength(0);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 429);
  });

  it("RPC error fails CLOSED -> ok:false, GitHub never called", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a thrown RPC also fails closed", async () => {
    rpc.mockRejectedValueOnce(new Error("socket hang up"));
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("syncUpdateAction: re-derives the decision server side", () => {
  it("status not available (no newer release) -> ok:false without calling merge-upstream", async () => {
    vi.stubEnv("AGENCY_BOARD_VERSION", "1.2.0");
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });

  it("status setup (no token) -> ok:false without calling merge-upstream", async () => {
    vi.stubEnv("AGENCY_BOARD_GITHUB_TOKEN", "");
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(syncCalls()).toHaveLength(0);
  });

  it("status hidden (GitHub unreachable) -> ok:false without calling merge-upstream", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 500)));
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
  });
});

describe("syncUpdateAction: success path", () => {
  it("syncs the env fork/branch with the env token, audits 200, revalidates the layout", async () => {
    vi.stubEnv("AGENCY_BOARD_UPDATE_BRANCH", "release");
    const r = await syncUpdateAction();
    expect(r).toEqual({ ok: true, message: SYNC_OK_MESSAGE });
    const s = syncCalls();
    expect(s).toHaveLength(1);
    expect(s[0].url).toBe(`https://api.github.com/repos/${FORK}/merge-upstream`);
    expect(s[0].init.method).toBe("POST");
    expect(JSON.parse(String(s[0].init.body))).toEqual({ branch: "release" });
    expect((s[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 200);
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard", "layout");
  });

  it("ignores every FormData value (fork, repo, owner, branch, token, url)", async () => {
    const r = await syncUpdateAction(
      form({
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
    expect(s[0].url).toBe(`https://api.github.com/repos/${FORK}/merge-upstream`);
    expect(JSON.parse(String(s[0].init.body))).toEqual({ branch: "main" });
    const hdr = s[0].init.headers as Record<string, string>;
    expect(hdr.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(calls)).not.toMatch(/attacker|evil/);
  });
});

describe("syncUpdateAction: failures map to fixed messages and leak nothing", () => {
  it("409 -> merge conflict message, audited 409", async () => {
    syncStatus = 409;
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/merge conflict/i);
    expect(r.message).toMatch(/manual sync/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 409);
    expect(revalidatePath).not.toHaveBeenCalledWith("/dashboard", "layout");
  });

  it("422 -> diverged message, audited 422", async () => {
    syncStatus = 422;
    const r = await syncUpdateAction();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/diverged/i);
    expect(logAdminAction).toHaveBeenCalledWith("update_sync", 422);
  });

  it("401 / 404 / 500 are ok:false with fixed text", async () => {
    for (const st of [401, 404, 500]) {
      syncStatus = st;
      const r = await syncUpdateAction();
      expect(r.ok).toBe(false);
      expect(r.message.length).toBeGreaterThan(10);
    }
  });

  it("the token never appears in any result, console output or audit call (GitHub echoing it back included)", async () => {
    const results: unknown[] = [];
    for (const st of [200, 401, 403, 404, 409, 422, 429, 500]) {
      syncStatus = st;
      syncBody = JSON.stringify({ message: `Bad credentials ${TOKEN}`, token: TOKEN });
      results.push(await syncUpdateAction());
    }
    // rate-limit and RPC-error branches too
    rpc.mockResolvedValueOnce({ data: false, error: null });
    results.push(await syncUpdateAction());
    rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: `leak ${TOKEN}` } });
    results.push(await syncUpdateAction());
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    expect(consoleText()).not.toContain(TOKEN);
    expect(JSON.stringify(logAdminAction.mock.calls)).not.toContain(TOKEN);
    expect(JSON.stringify(revalidatePath.mock.calls)).not.toContain(TOKEN);
  });
});
