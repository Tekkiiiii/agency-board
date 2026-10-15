"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { db } from "../../../lib/db";
import { logAdminAction } from "../../../lib/dash/log";
import { requireAdmin } from "../../../lib/dash/session";
import { getToken, resolveBranch, resolveFork, resolveUpstream } from "../../../lib/update/config";
import { SHA_RE } from "../../../lib/update/release";
import { getUpdateStatus } from "../../../lib/update/status";
import { syncFork, type SyncErrorCode } from "../../../lib/update/sync";

export type UpdateResult = { ok: true; message: string } | { ok: false; message: string };

const RATE_MESSAGE = "Too many attempts, wait a minute";
const REJECTED_MESSAGE = "Request rejected. Reload the page and try again.";
const UNAVAILABLE_MESSAGE = "No update is available to apply right now. Reload the page to see the current state.";
const BAD_SHA_MESSAGE = "The release to apply is missing or invalid. Reload the page and try again.";
const NOT_CONFIGURED_MESSAGE = "One-click updates are not configured. Use the manual sync link instead.";

// Audit status for a failed sync (access_log.result is an HTTP-ish code; the message returned to the UI is separate and fixed).
const STATUS_FOR: Record<SyncErrorCode, number> = {
  conflict: 409,
  unreachable: 422,
  tag_not_found: 404,
  tag_moved: 412, // its own audit code: the release changed since the page loaded (a merge conflict stays 409)
  auth: 401,
  not_found: 404,
  rate_limited: 429,
  network: 502,
  unknown: 502,
};

// Defence in depth on top of Next's own Origin/Host check for server actions: a browser-supplied Origin must match the
// host the request was addressed to, and Fetch Metadata must not say cross-site. Absent headers (non-browser callers)
// are allowed through: the admin session in requireAdmin() is the real gate.
async function sameOrigin(): Promise<boolean> {
  const h = await headers();
  const site = h.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = h.get("origin");
  if (origin === null) return true;
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").split(",")[0].trim().toLowerCase();
  try {
    return host !== "" && new URL(origin).host.toLowerCase() === host;
  } catch {
    return false; // "null" and anything unparseable
  }
}

// Merges the latest upstream RELEASE (its tagged commit, never upstream's branch head) into the deployment's fork.
// The only client input is `expectedSha`, the release commit the admin was shown. It can only NARROW what gets merged:
// syncFork resolves the tag fresh and refuses unless that commit equals it, then merges the server-resolved commit.
// Fork, branch, token and tag come from server env / the re-derived status, so a forged request can neither redirect the
// call nor force it.
export async function syncUpdateAction(fd?: FormData): Promise<UpdateResult> {
  await requireAdmin();

  if (!(await sameOrigin())) {
    await logAdminAction("update_sync", 403);
    return { ok: false, message: REJECTED_MESSAGE };
  }

  // Fails CLOSED: a broken rate limiter must not become an open one.
  let allowed = false;
  try {
    const { data, error } = await db().rpc("hub_rate_hit", { p_key: "dash:update-sync", p_window_seconds: 60, p_max: 3 });
    if (error) console.error("[hub] update-sync rate-limit failed", String(error.code ?? "unknown"));
    else allowed = data === true;
  } catch {
    console.error("[hub] update-sync rate-limit failed", "unknown");
  }
  if (!allowed) {
    await logAdminAction("update_sync", 429);
    return { ok: false, message: RATE_MESSAGE };
  }

  const status = await getUpdateStatus();
  if (status.state !== "available") {
    await logAdminAction("update_sync", 409);
    return { ok: false, message: UNAVAILABLE_MESSAGE };
  }

  const fork = resolveFork();
  const branch = resolveBranch();
  const token = getToken();
  const upstream = resolveUpstream();
  if (!fork || !branch || !token || !upstream) {
    await logAdminAction("update_sync", 409);
    return { ok: false, message: NOT_CONFIGURED_MESSAGE };
  }

  // Strict shape check on the one client value (also rejects a File or a missing field). The message is fixed: the
  // submitted value is never echoed.
  const shown = fd instanceof FormData ? fd.get("expectedSha") : null;
  if (typeof shown !== "string" || !SHA_RE.test(shown)) {
    await logAdminAction("update_sync", 400);
    return { ok: false, message: BAD_SHA_MESSAGE };
  }

  // The tag comes from the re-derived status (never from the request); syncFork resolves it to a commit fresh and
  // refuses (tag_moved, no merge call) unless that commit is the one the admin was shown.
  const r = await syncFork({ fork, branch, token, upstream, tag: status.tag, expectedSha: shown });
  await logAdminAction("update_sync", r.ok ? 200 : STATUS_FOR[r.code]);
  if (!r.ok) return { ok: false, message: r.message };
  // Audit trail of what was merged: the sha is the one syncFork resolved fresh and sent to GitHub (r.sha), not the form value.
  // tag is regex-validated, sha is 40-hex: no secrets, no injection.
  if (!r.upToDate) console.info("[hub] update sync merged", { tag: status.tag, sha: r.sha });
  // Also covers "your fork already contains the tag": the page may be stale, so refresh it either way.
  revalidatePath("/dashboard", "layout");
  return { ok: true, message: r.message };
}
