// Semver helpers for the in-app Update button (server-side only, no I/O).
// Accepts x.y.z with an optional leading "v", an optional -prerelease and ignorable +build metadata. Anything else is
// invalid and yields null, so a malformed tag can never look like an update.

export type Semver = { major: number; minor: number; patch: number; prerelease: string[] };

const SEMVER_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(input: unknown): Semver | null {
  if (typeof input !== "string") return null;
  const m = input.match(SEMVER_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ? m[4].split(".") : [],
  };
}

const NUMERIC = /^\d+$/;

function cmp(a: number, b: number): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semver 2.0 precedence for prerelease identifiers: numeric < alphanumeric, numeric compared as numbers, a longer
// identifier list wins when all shared identifiers are equal.
function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release is greater than any prerelease
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    const xn = NUMERIC.test(x);
    const yn = NUMERIC.test(y);
    if (xn && yn) return cmp(Number(x), Number(y));
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return cmp(a.length, b.length);
}

// null when either side is not valid semver.
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return null;
  return cmp(x.major, y.major) || cmp(x.minor, y.minor) || cmp(x.patch, y.patch) || comparePrerelease(x.prerelease, y.prerelease);
}

export function isNewer(latest: string, current: string): boolean {
  return compareSemver(latest, current) === 1;
}

// Injected at build time by next.config.ts (`env`, from package.json). Next inlines the LITERAL expression
// `process.env.AGENCY_BOARD_VERSION`, so it must not be read through an aliased env object. "" when absent.
export function runningVersion(): string {
  return (process.env.AGENCY_BOARD_VERSION ?? "").trim();
}
