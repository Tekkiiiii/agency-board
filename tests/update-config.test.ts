// In-app Update button: upstream / fork / branch / token resolution + validation. No network, no DB.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { inspect } from "node:util";
import {
  DEFAULT_UPSTREAM,
  GITHUB_API,
  isValidRepo,
  isValidBranch,
  sameRepo,
  resolveUpstream,
  resolveFork,
  resolveBranch,
  getToken,
} from "../lib/update/config";

const TOKEN = "fake-test-token-0000";

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

const BAD_REPOS = [
  "", " ", "a", "..", ".", "owner/..", "owner/.", "a/b@evil", "a/b/../c", "a/b/c", "/a/b", "a/b/", "a//b",
  "https://evil.com/x/y", "http://a/b", "evil.com/x", "a/b c", " a/b", "a/b ", "a /b", "a/b\n", "a\n/b", "a/b\t",
  "a/b?x=1", "a/b#h", "a\\b", "a/b%2e%2e", "ö/b", "a/ü", "a/b​", "-a/b", "a-/b", "a b/c", "a/", "/", "a/b;ls",
  "a.b/c", "a_b/c", "a/" + "x".repeat(101), "x".repeat(40) + "/b", "user:pw@a/b", "a/b:c",
];

describe("isValidRepo", () => {
  it.each(["me/agency-board", "a/b", "my-org/my.repo_1", "a1/.github", "A-b-C/x.y.z", "a/b..c"])("accepts %j", (s) => {
    expect(isValidRepo(s)).toBe(true);
  });
  it.each(BAD_REPOS)("rejects %j", (s) => {
    expect(isValidRepo(s)).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isValidRepo(undefined)).toBe(false);
    expect(isValidRepo(null)).toBe(false);
    expect(isValidRepo(5)).toBe(false);
  });
});

describe("isValidBranch", () => {
  it.each(["main", "release/1.0", "feature_x-1.2", "a", "v1.0.0"])("accepts %j", (s) => {
    expect(isValidBranch(s)).toBe(true);
  });
  it.each(["", "..", "a..b", "../main", "main/..", "/main", "-main", "--upload-pack=x", "ma in", "main\n", "a:b", "a@b", "a?b", "a#b",
    "a\\b", "über", "x".repeat(101), "refs/heads/../x"])("rejects %j", (s) => {
    expect(isValidBranch(s)).toBe(false);
  });
  it("rejects non-strings", () => {
    expect(isValidBranch(undefined)).toBe(false);
    expect(isValidBranch(1)).toBe(false);
  });
});

describe("sameRepo", () => {
  it("compares case-insensitively", () => {
    expect(sameRepo(DEFAULT_UPSTREAM, DEFAULT_UPSTREAM.toLowerCase().toUpperCase())).toBe(true);
    expect(sameRepo("a/b", "a/c")).toBe(false);
  });
});

describe("constants", () => {
  it("pins the default upstream and the API host", () => {
    expect(DEFAULT_UPSTREAM).toMatch(/^[A-Za-z0-9-]+\/agency-board$/);
    expect(GITHUB_API).toBe("https://api.github.com");
  });
});

describe("resolveUpstream", () => {
  it("defaults to the pinned upstream when unset or blank", () => {
    expect(resolveUpstream({})).toBe(DEFAULT_UPSTREAM);
    expect(resolveUpstream({ AGENCY_BOARD_UPSTREAM: "" })).toBe(DEFAULT_UPSTREAM);
    expect(resolveUpstream({ AGENCY_BOARD_UPSTREAM: "   " })).toBe(DEFAULT_UPSTREAM);
  });
  it("accepts a valid override (trimmed)", () => {
    expect(resolveUpstream({ AGENCY_BOARD_UPSTREAM: " my-org/agency-board " })).toBe("my-org/agency-board");
  });
  // Surrounding whitespace is trimmed by design (padded env values are normal), so only values that stay invalid once trimmed.
  it.each(BAD_REPOS.filter((s) => s.trim() !== "" && !isValidRepo(s.trim())))("fails closed (null) for invalid override %j, warns without echoing it", (bad) => {
    const env = { AGENCY_BOARD_UPSTREAM: bad, AGENCY_BOARD_GITHUB_TOKEN: TOKEN };
    expect(resolveUpstream(env)).toBeNull();
    expect(spies.warn).toHaveBeenCalled();
    const out = consoleText();
    expect(out).toContain("AGENCY_BOARD_UPSTREAM");
    expect(out).not.toContain(TOKEN);
    if (bad.trim().length >= 8) expect(out).not.toContain(bad.trim());
  });
});

describe("resolveFork", () => {
  it("is null when nothing identifies the fork", () => {
    expect(resolveFork({})).toBeNull();
    expect(resolveFork({ AGENCY_BOARD_FORK: "  " })).toBeNull();
  });
  it("uses the explicit AGENCY_BOARD_FORK", () => {
    expect(resolveFork({ AGENCY_BOARD_FORK: "me/my-board" })).toBe("me/my-board");
  });
  it("falls back to the Vercel system env pair", () => {
    expect(resolveFork({ VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "my-board" })).toBe("me/my-board");
  });
  it("prefers the explicit value over Vercel", () => {
    expect(resolveFork({ AGENCY_BOARD_FORK: "a/explicit", VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "other" })).toBe("a/explicit");
  });
  it("needs both Vercel values", () => {
    expect(resolveFork({ VERCEL_GIT_REPO_OWNER: "me" })).toBeNull();
    expect(resolveFork({ VERCEL_GIT_REPO_SLUG: "my-board" })).toBeNull();
  });
  it("rejects invalid values, never echoing them (a pasted token must not reach the log)", () => {
    for (const bad of ["..", "owner/..", "a/b@evil", "a/b/../c", "https://evil.com/x/y", "a/b c", TOKEN]) {
      spies.warn.mockClear();
      expect(resolveFork({ AGENCY_BOARD_FORK: bad })).toBeNull();
      expect(consoleText()).not.toContain(bad);
    }
    expect(resolveFork({ VERCEL_GIT_REPO_OWNER: "..", VERCEL_GIT_REPO_SLUG: ".." })).toBeNull();
    expect(resolveFork({ VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "a/b" })).toBeNull();
  });
  it("does not fall back to Vercel when an explicit value is invalid", () => {
    expect(resolveFork({ AGENCY_BOARD_FORK: "bad value", VERCEL_GIT_REPO_OWNER: "me", VERCEL_GIT_REPO_SLUG: "my-board" })).toBeNull();
  });
});

describe("resolveBranch", () => {
  it("defaults to main", () => {
    expect(resolveBranch({})).toBe("main");
    expect(resolveBranch({ AGENCY_BOARD_UPDATE_BRANCH: " " })).toBe("main");
  });
  it("accepts a valid override", () => {
    expect(resolveBranch({ AGENCY_BOARD_UPDATE_BRANCH: "release/1.x" })).toBe("release/1.x");
  });
  it("fails closed (null) on invalid override with a value-free warning", () => {
    for (const bad of ["..", "a..b", "/x", "-x", "a b", TOKEN + " x"]) {
      spies.warn.mockClear();
      expect(resolveBranch({ AGENCY_BOARD_UPDATE_BRANCH: bad })).toBeNull();
      expect(spies.warn).toHaveBeenCalled();
      expect(consoleText()).toContain("AGENCY_BOARD_UPDATE_BRANCH");
      if (bad.length >= 8) expect(consoleText()).not.toContain(bad);
    }
  });
});

describe("getToken", () => {
  it("trims and treats empty as unset", () => {
    expect(getToken({})).toBeNull();
    expect(getToken({ AGENCY_BOARD_GITHUB_TOKEN: "" })).toBeNull();
    expect(getToken({ AGENCY_BOARD_GITHUB_TOKEN: "  \n " })).toBeNull();
    expect(getToken({ AGENCY_BOARD_GITHUB_TOKEN: `  ${TOKEN}\n` })).toBe(TOKEN);
  });
  it("never logs", () => {
    getToken({ AGENCY_BOARD_GITHUB_TOKEN: TOKEN });
    expect(consoleText()).toBe("");
  });
});
