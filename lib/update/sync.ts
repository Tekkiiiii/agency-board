// One-click "update to the latest release" for the in-app Update button (server-side only).
// 1. Resolve the release TAG to its commit SHA on upstream (fresh, never cached: a moved tag must be seen).
//    If that fresh commit is not the one the admin was shown (expectedSha), refuse: the tag moved since the page loaded.
// 2. POST https://api.github.com/repos/{fork}/merges {"base": branch, "head": <that 40-hex sha>} with the user's
//    fine-grained token, so only the release commit is merged into the fork, never upstream's branch head.
//    The head is always the sha from the fresh lookup in step 1; expectedSha is only ever compared, never merged.
// The token is sent in one header, only to api.github.com. Results use FIXED messages (never the GitHub body, headers
// or any thrown error text), and failures log the status/code only. Never forces and never retries.

import { apiUrl, GITHUB_API_VERSION, isValidBranch, isValidRepo, repoPath } from "./config";
import { resolveTagCommit, SHA_RE } from "./release";

export type SyncErrorCode =
  | "conflict"
  | "unreachable"
  | "tag_not_found"
  | "tag_moved"
  | "auth"
  | "not_found"
  | "rate_limited"
  | "network"
  | "unknown";
// sha (ok results) is the commit the fresh tag lookup resolved and that was sent to GitHub as the merge head (so a caller logs what was
// really merged, not what the form claimed).
export type SyncResult = { ok: true; message: string; sha: string; upToDate?: true } | { ok: false; code: SyncErrorCode; message: string };

export type SyncInput = {
  fork: string;
  branch: string;
  token: string;
  upstream: string;
  tag: string;
  expectedSha: string; // the release commit the admin was shown; the sync refuses unless the fresh tag lookup equals it
  fetch?: typeof fetch;
};

const TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_BYTES = 10_000;
const TAG_RE = /^[A-Za-z0-9._-]{1,100}$/;

export const SYNC_OK_MESSAGE =
  "Sync started. Vercel is redeploying; the new version appears in a minute or two. Pending migrations apply during the build.";

export function syncUpToDateMessage(tag: string): string {
  return `Your fork already contains ${tag}. Nothing to merge; if the dashboard still shows an update, wait for Vercel to finish deploying.`;
}

export const TAG_MOVED_MESSAGE = "The release changed since you opened this page; reload and review it again";

const MESSAGES: Record<SyncErrorCode, string> = {
  conflict: "Merge conflict: your fork has changes that conflict with the release. Resolve it on GitHub (use the manual sync link), then try again.",
  unreachable:
    "GitHub could not merge the release commit into your fork (the commit is not reachable from your fork, or GitHub rejected the request). Use the manual sync link to merge the release on GitHub.",
  tag_not_found:
    "The release tag was not found on upstream (it may have been removed or renamed). Nothing was changed. Try again later or use the manual sync link.",
  tag_moved: TAG_MOVED_MESSAGE,
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

// 403 with rate-limit headers is throttling, not a permissions problem.
function isThrottled(status: number, headers: Headers): boolean {
  return status === 429 || headers.get("x-ratelimit-remaining") === "0" || headers.has("retry-after");
}

// Only used to CLASSIFY a 404 (the body is never returned or logged). Reads at most MAX_ERROR_BODY_BYTES; anything
// larger, unreadable or not a JSON string message is "not_found".
async function notFoundCode(res: Response): Promise<SyncErrorCode> {
  try {
    const reader = res.body?.getReader();
    if (!reader) return "not_found";
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        return "not_found";
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    return typeof message === "string" && message.startsWith("Head does not exist") ? "unreachable" : "not_found";
  } catch {
    return "not_found";
  }
}

async function mergeCode(res: Response): Promise<SyncErrorCode> {
  const { status, headers } = res;
  if (status === 409) return "conflict";
  if (status === 422) return "unreachable";
  if (status === 401) return "auth";
  if (status === 404) return notFoundCode(res);
  if (isThrottled(status, headers)) return "rate_limited";
  if (status === 403) return "auth";
  return "unknown";
}

export async function syncFork(input: SyncInput): Promise<SyncResult> {
  const { fork, branch, token, upstream, tag, expectedSha } = input;
  if (!isValidRepo(fork) || !isValidRepo(upstream) || !isValidBranch(branch)) return fail("unknown");
  if (typeof tag !== "string" || !TAG_RE.test(tag) || tag.includes("..")) return fail("unknown");
  if (typeof expectedSha !== "string" || !SHA_RE.test(expectedSha)) return fail("unknown");
  // Bearer value goes into a header: refuse anything that is empty or not a single printable token.
  if (!token || !/^[\x21-\x7E]+$/.test(token)) return fail("auth");
  const doFetch = input.fetch ?? globalThis.fetch;

  const resolved = await resolveTagCommit({ upstream, tag, fetch: doFetch, token });
  if (!resolved.ok) {
    if (resolved.reason === "not_found") return fail("tag_not_found", 404);
    if (resolved.status === 401) return fail("auth", 401);
    if (resolved.limited) return fail("rate_limited", resolved.status);
    if (resolved.status === 403) return fail("auth", 403);
    return fail("unknown", resolved.status);
  }
  // The tag moved after the admin opened the page: nothing is merged. Plain equality on two 40-hex strings (no secret).
  if (resolved.sha !== expectedSha) return fail("tag_moved", 412);

  try {
    const res = await doFetch(apiUrl(`${repoPath(fork)}/merges`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "agency-board-update",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      // head is always the 40-hex commit sha resolved above, never a branch name.
      body: JSON.stringify({ base: branch, head: resolved.sha, commit_message: `Update to ${tag}` }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 201) return { ok: true, message: SYNC_OK_MESSAGE, sha: resolved.sha };
    if (res.status === 204) return { ok: true, upToDate: true, message: syncUpToDateMessage(tag), sha: resolved.sha };
    return fail(await mergeCode(res), res.status);
  } catch {
    // Deliberately drops the error: its text could carry request details.
    return fail("network");
  }
}
