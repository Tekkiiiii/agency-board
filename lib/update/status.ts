// The single decision behind the in-app Update button (server-side only). Never throws: every failure, misconfiguration
// or anomaly collapses to {state:"hidden"} so the dashboard simply shows nothing.
//   hidden     no newer upstream release, check failed/misconfigured, running version unknown, or this is not a fork
//   setup      an update exists but one-click sync is not configured (no token, or the fork cannot be resolved): hint only
//   available  an update exists and sync is configured: show notes, migration count and the Update button

import { getToken, resolveBranch, resolveFork, resolveUpstream, sameRepo } from "./config";
import { fetchLatestRelease, fetchTagCommit, pendingMigrationCount } from "./release";
import { isNewer, parseSemver, runningVersion } from "./version";

export type UpdateStatus =
  | { state: "hidden" }
  | { state: "setup"; latest: string; tag: string; current: string; url: string; manualSyncUrl: string }
  | {
      state: "available";
      latest: string;
      tag: string; // the release tag_name (e.g. "v1.2.3"): the sync resolves it to a commit and merges only that commit
      current: string;
      notes: string;
      url: string;
      migrations: number | null;
      sha: string | null; // the release commit this status shows (the tag's commit, cached up to 1 h); the Update form submits it and the sync refuses if the tag moved
      fork: string;
      manualSyncUrl: string;
    };

export type StatusDeps = {
  fetch?: typeof fetch;
  now?: () => number;
  env?: Record<string, string | undefined>;
  runningVersion?: string; // default: the build-time injected AGENCY_BOARD_VERSION
  bundledMigrations?: readonly string[] | null; // default: the build-time injected AGENCY_BOARD_MIGRATIONS
};

const HIDDEN: UpdateStatus = { state: "hidden" };

async function compute(deps: StatusDeps): Promise<UpdateStatus> {
  const env = deps.env ?? process.env;
  const upstream = resolveUpstream(env);
  const branch = resolveBranch(env);
  if (!upstream || !branch) return HIDDEN; // misconfigured override: fail closed

  const runningRaw = (deps.runningVersion ?? runningVersion()).trim();
  if (!parseSemver(runningRaw)) return HIDDEN; // unknown running version: cannot claim an update
  const current = runningRaw.replace(/^v/, "");

  const release = await fetchLatestRelease({ fetch: deps.fetch, now: deps.now, env });
  if (!release || !isNewer(release.version, current)) return HIDDEN;

  const fork = resolveFork(env);
  if (fork && sameRepo(fork, upstream)) return HIDDEN; // running the upstream itself: there is no fork to sync

  // Manual fallback = the same thing the button does: merge the release tag (not upstream's branch head) into the fork.
  const manualSyncUrl = fork
    ? `https://github.com/${fork}/compare/${branch}...${upstream.split("/")[0]}:${release.tag}`
    : `https://github.com/${upstream}/releases/tag/${release.tag}`;

  const token = getToken(env);
  if (!token || !fork) {
    return { state: "setup", latest: release.version, tag: release.tag, current, url: release.url, manualSyncUrl };
  }

  // Counted on the release TAG's tree: that is the commit the sync merges, not upstream's branch head.
  // Both lookups share the cached tag->commit entry, so the count and the sha always describe the same commit.
  const sha = await fetchTagCommit({ tag: release.tag, fetch: deps.fetch, now: deps.now, env });
  const migrations = await pendingMigrationCount({ tag: release.tag, fetch: deps.fetch, now: deps.now, env, bundled: deps.bundledMigrations });
  return { state: "available", latest: release.version, tag: release.tag, current, notes: release.body, url: release.url, migrations, sha, fork, manualSyncUrl };
}

export async function getUpdateStatus(deps: StatusDeps = {}): Promise<UpdateStatus> {
  try {
    return await compute(deps);
  } catch {
    return HIDDEN;
  }
}

// First-render bound for the dashboard layout: the cold lookup (up to three unauthenticated GitHub calls, 5 s timeout each)
// must never hold the page. After `ms` the banner is simply hidden; the in-flight lookup keeps going and warms the
// cache, so the next render gets the real status. Never throws, never leaves its timer running.
export async function getUpdateStatusWithin(ms = 1500, deps: StatusDeps = {}): Promise<UpdateStatus> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<UpdateStatus>((resolve) => {
    timer = setTimeout(() => resolve(HIDDEN), ms);
  });
  try {
    return await Promise.race([getUpdateStatus(deps), timeout]);
  } catch {
    return HIDDEN;
  } finally {
    clearTimeout(timer);
  }
}
