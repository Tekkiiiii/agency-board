// In-app Update button: semver helpers + build-time version/migration injection (next.config.ts). No network, no DB.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseSemver, compareSemver, isNewer, runningVersion } from "../lib/update/version";
import nextConfig from "../next.config";

describe("parseSemver", () => {
  it("parses x.y.z with optional leading v", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("v10.20.30")).toEqual({ major: 10, minor: 20, patch: 30, prerelease: [] });
  });

  it("parses prerelease identifiers and ignores build metadata", () => {
    expect(parseSemver("1.2.3-rc.1")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ["rc", "1"] });
    expect(parseSemver("v1.2.3-alpha")?.prerelease).toEqual(["alpha"]);
    expect(parseSemver("1.2.3+build.5")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("1.2.3-rc.1+build.5")?.prerelease).toEqual(["rc", "1"]);
  });

  it.each([
    "", " ", "v", "1", "1.2", "1.2.3.4", "a.b.c", "1.2.x", " 1.2.3", "1.2.3 ", "1.2.3-", "1.2.3-rc..1", "1.2.3-rc_1",
    "vv1.2.3", "-1.2.3", "1.-2.3", "latest", "1.2.3\n", "１.２.３", "99999999999.0.0",
  ])("rejects %j", (s) => {
    expect(parseSemver(s)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(parseSemver(undefined)).toBeNull();
    expect(parseSemver(null)).toBeNull();
    expect(parseSemver(123)).toBeNull();
    expect(parseSemver({})).toBeNull();
  });
});

describe("compareSemver", () => {
  it("compares numerically, not lexically", () => {
    expect(compareSemver("1.2.3", "1.10.0")).toBe(-1);
    expect(compareSemver("1.10.0", "1.2.3")).toBe(1);
    expect(compareSemver("2.0.0", "1.99.99")).toBe(1);
    expect(compareSemver("0.1.10", "0.1.9")).toBe(1);
  });

  it("treats equal versions and the v prefix as equal, ignoring build metadata", () => {
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
    expect(compareSemver("1.2.3+a", "1.2.3+b")).toBe(0);
  });

  it("orders prerelease below the release, following the semver precedence chain", () => {
    const chain = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1-rc.1",
      "1.0.1",
    ];
    for (let i = 0; i < chain.length; i++) {
      for (let j = 0; j < chain.length; j++) {
        expect(compareSemver(chain[i], chain[j]), `${chain[i]} vs ${chain[j]}`).toBe(Math.sign(i - j));
      }
    }
  });

  it("returns null when either side is invalid", () => {
    expect(compareSemver("nope", "1.0.0")).toBeNull();
    expect(compareSemver("1.0.0", "")).toBeNull();
    expect(compareSemver("1.0", "1.0.1")).toBeNull();
    expect(compareSemver(undefined as unknown as string, "1.0.0")).toBeNull();
  });
});

describe("isNewer", () => {
  it("is true only when latest is strictly greater and both are valid", () => {
    expect(isNewer("v1.1.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0-rc.1")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "1.1.0")).toBe(false);
    expect(isNewer("1.0.0-rc.1", "1.0.0")).toBe(false);
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "")).toBe(false);
  });
});

describe("runningVersion", () => {
  const saved = process.env.AGENCY_BOARD_VERSION;
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENCY_BOARD_VERSION;
    else process.env.AGENCY_BOARD_VERSION = saved;
  });

  it("reads process.env.AGENCY_BOARD_VERSION at call time", () => {
    process.env.AGENCY_BOARD_VERSION = "1.4.2";
    expect(runningVersion()).toBe("1.4.2");
    process.env.AGENCY_BOARD_VERSION = "2.0.0";
    expect(runningVersion()).toBe("2.0.0");
  });

  it("is the empty string when absent or blank", () => {
    delete process.env.AGENCY_BOARD_VERSION;
    expect(runningVersion()).toBe("");
    process.env.AGENCY_BOARD_VERSION = "   ";
    expect(runningVersion()).toBe("");
  });
});

describe("next.config.ts build-time injection", () => {
  it("injects AGENCY_BOARD_VERSION from package.json", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(nextConfig.env?.AGENCY_BOARD_VERSION).toBe(pkg.version);
    expect(parseSemver(pkg.version)).not.toBeNull();
  });

  it("injects the 14-digit versions of supabase/migrations/*.sql as a comma list", () => {
    const expected = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .map((f) => f.match(/^(\d{14})_.*\.sql$/)?.[1])
      .filter((v): v is string => !!v)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    const injected = nextConfig.env?.AGENCY_BOARD_MIGRATIONS;
    expect(typeof injected).toBe("string");
    expect((injected as string).split(",")).toEqual(expected);
    for (const v of (injected as string).split(",")) expect(v).toMatch(/^\d{14}$/);
  });

  it("keeps the existing poweredByHeader setting", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
