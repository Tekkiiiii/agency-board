// Single parse point for the in-app Update button configuration (server-side only: reads env, never import from a client component).
//
// Env (all optional):
//   AGENCY_BOARD_UPSTREAM        "owner/repo" release source      default Tekkiiiii/agency-board (advanced; invalid => feature off)
//   AGENCY_BOARD_FORK            "owner/repo" of this deployment's fork; else Vercel's VERCEL_GIT_REPO_OWNER + VERCEL_GIT_REPO_SLUG
//   AGENCY_BOARD_UPDATE_BRANCH   branch of the fork to sync        default "main"
//   AGENCY_BOARD_GITHUB_TOKEN    fine-grained PAT (Contents: read and write, the fork only) for the one-click sync
// Nothing here is ever taken from a request. Invalid overrides resolve to null and warn with the variable NAME only,
// never the value (a token pasted into the wrong variable must not reach the logs).

export const DEFAULT_UPSTREAM = "Tekkiiiii/agency-board";
// The only host this feature talks to. URLs are built from this constant plus validated, encoded path segments.
export const GITHUB_API = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

type Env = Record<string, string | undefined>;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

export function isValidRepo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  if (parts.length !== 2) return false;
  const [owner, repo] = parts;
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repo)) return false;
  return !/^\.+$/.test(repo); // "." and ".." are path traversal, not repository names
}

export function isValidBranch(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (!BRANCH_RE.test(value)) return false;
  return !value.includes("..") && !value.startsWith("/") && !value.startsWith("-");
}

export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function warnInvalid(name: string): void {
  console.warn(`update: ${name} is not valid and is ignored, so the update check is off or unresolved`);
}

export function resolveUpstream(env: Env = process.env): string | null {
  const raw = (env.AGENCY_BOARD_UPSTREAM ?? "").trim();
  if (!raw) return DEFAULT_UPSTREAM;
  if (isValidRepo(raw)) return raw;
  warnInvalid("AGENCY_BOARD_UPSTREAM");
  return null;
}

// null = unresolved (nothing configured, or the configured value is invalid; an invalid explicit value does not fall
// back to the Vercel pair, so a typo cannot silently point the sync somewhere else).
export function resolveFork(env: Env = process.env): string | null {
  const explicit = (env.AGENCY_BOARD_FORK ?? "").trim();
  if (explicit) {
    if (isValidRepo(explicit)) return explicit;
    warnInvalid("AGENCY_BOARD_FORK");
    return null;
  }
  const owner = (env.VERCEL_GIT_REPO_OWNER ?? "").trim();
  const slug = (env.VERCEL_GIT_REPO_SLUG ?? "").trim();
  if (!owner || !slug) return null;
  const fork = `${owner}/${slug}`;
  if (isValidRepo(fork)) return fork;
  warnInvalid("VERCEL_GIT_REPO_OWNER/VERCEL_GIT_REPO_SLUG");
  return null;
}

export function resolveBranch(env: Env = process.env): string | null {
  const raw = (env.AGENCY_BOARD_UPDATE_BRANCH ?? "").trim();
  if (!raw) return "main";
  if (isValidBranch(raw)) return raw;
  warnInvalid("AGENCY_BOARD_UPDATE_BRANCH");
  return null;
}

export function getToken(env: Env = process.env): string | null {
  const t = (env.AGENCY_BOARD_GITHUB_TOKEN ?? "").trim();
  return t || null;
}

// Builds an api.github.com URL from an already-validated path ("/repos/o/r/..."). Defence in depth: refuses anything
// that would not parse back to the pinned origin.
export function apiUrl(path: string): string {
  const url = GITHUB_API + path;
  if (!path.startsWith("/repos/") || new URL(url).origin !== GITHUB_API) throw new Error("update: refusing non-api.github.com URL");
  return url;
}

export function repoPath(repo: string): string {
  return "/repos/" + repo.split("/").map(encodeURIComponent).join("/");
}
