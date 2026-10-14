// One-click "sync fork" for the in-app Update button (server-side only).
// POST https://api.github.com/repos/{fork}/merge-upstream {"branch": ...} with the user's fine-grained token.
// The token is sent in one header and nowhere else: results use FIXED messages (never the GitHub body, headers or any
// thrown error text), and failures log the status/code only. Never forces and never retries.

import { apiUrl, GITHUB_API_VERSION, isValidBranch, isValidRepo, repoPath } from "./config";

export type SyncErrorCode = "conflict" | "diverged" | "auth" | "not_found" | "rate_limited" | "network" | "unknown";
export type SyncResult = { ok: true; message: string } | { ok: false; code: SyncErrorCode; message: string };

export type SyncInput = {
  fork: string;
  branch: string;
  token: string;
  fetch?: typeof fetch;
};

const TIMEOUT_MS = 10_000;

export const SYNC_OK_MESSAGE =
  "Sync started. Vercel is redeploying; the new version appears in a minute or two. Pending migrations apply during the build.";

const MESSAGES: Record<SyncErrorCode, string> = {
  conflict: "Merge conflict: your fork has changes that conflict with upstream. Resolve it on GitHub (use the manual sync link), then try again.",
  diverged: "GitHub cannot sync this fork automatically (it has diverged from upstream). Use the manual sync link to merge on GitHub.",
  auth: "GitHub rejected the token. Check that AGENCY_BOARD_GITHUB_TOKEN is valid, not expired, and has Contents: read and write on your fork.",
  not_found: "GitHub could not find the fork or the branch. Check AGENCY_BOARD_FORK and AGENCY_BOARD_UPDATE_BRANCH, and that the token can access the fork.",
  rate_limited: "GitHub is rate limiting requests. Wait a few minutes and try again.",
  network: "Could not reach GitHub. Try again in a moment.",
  unknown: "GitHub returned an unexpected response. Use the manual sync link, or try again later.",
};

function fail(code: SyncErrorCode, status?: number): SyncResult {
  console.error("update: sync failed", status === undefined ? { code } : { status, code });
  return { ok: false, code, message: MESSAGES[code] };
}

function codeFor(status: number, headers: Headers): SyncErrorCode {
  if (status === 409) return "conflict";
  if (status === 422) return "diverged";
  if (status === 401) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 403) {
    // A 403 with rate-limit headers is throttling, not a permissions problem.
    return headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after") ? "rate_limited" : "auth";
  }
  return "unknown";
}

export async function syncFork(input: SyncInput): Promise<SyncResult> {
  const { fork, branch, token } = input;
  if (!isValidRepo(fork) || !isValidBranch(branch)) return fail("unknown");
  // Bearer value goes into a header: refuse anything that is empty or not a single printable token.
  if (!token || !/^[\x21-\x7E]+$/.test(token)) return fail("auth");
  try {
    const doFetch = input.fetch ?? globalThis.fetch;
    const res = await doFetch(apiUrl(`${repoPath(fork)}/merge-upstream`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agency-board-update",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({ branch }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 200) return { ok: true, message: SYNC_OK_MESSAGE };
    return fail(codeFor(res.status, res.headers), res.status);
  } catch {
    // Deliberately drops the error: its text could carry request details.
    return fail("network");
  }
}
