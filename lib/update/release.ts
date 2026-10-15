// Upstream release, release-tag and migration lookup for the in-app Update button (server-side only).
// Every cached call is an unauthenticated GET to the literal host https://api.github.com (no Authorization header: the
// 60 req/h anonymous limit is why results are cached). The one exception is resolveTagCommit with an explicit token,
// which only lib/update/sync.ts passes at sync time (never cached, never logged). Nothing from a response is ever used
// as a URL, host or header; any shape anomaly returns null / unavailable, which the caller treats as "unknown".

import { apiUrl, GITHUB_API_VERSION, isValidRepo, repoPath, resolveUpstream } from "./config";
import { parseSemver } from "./version";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type LatestRelease = {
  tag: string;
  version: string;
  name: string;
  body: string;
  url: string;
  publishedAt: string | null;
};

export type LookupOptions = {
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  env?: Env;
};

export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const NEGATIVE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 5000;
const MAX_RESPONSE_CHARS = 1_000_000;
const MAX_BODY_CHARS = 4000;

// ---- cache: success ttlMs (1 h), failure 5 min, concurrent callers share one in-flight request ----

type Entry = { expires: number; value: Promise<unknown> };
const cache = new Map<string, Entry>();

// Test-only: the cache is module state.
export function __resetCacheForTests(): void {
  cache.clear();
}

function cached<T>(key: string, now: () => number, ttlMs: number, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache.get(key);
  if (hit && now() < hit.expires) return hit.value as Promise<T | null>;
  const entry: Entry = { expires: Infinity, value: Promise.resolve(null) };
  entry.value = Promise.resolve()
    .then(load)
    .catch(() => null)
    .then((v) => {
      entry.expires = now() + (v === null ? NEGATIVE_TTL_MS : ttlMs);
      return v;
    });
  cache.set(key, entry);
  return entry.value as Promise<T | null>;
}

// ---- transport ----

type Fetched = { status: number; json: unknown; limited: boolean };

// One GET to a validated api.github.com path. Resolves with the status and the parsed JSON body (undefined unless the
// status is 200 and the body is small, valid JSON). Never surfaces a raw body. `token` adds the Authorization header.
async function request(path: string, doFetch: FetchLike, token?: string): Promise<Fetched> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "agency-board-update-check",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await doFetch(apiUrl(path), {
    method: "GET",
    headers,
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const limited = res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after");
  if (res.status !== 200) return { status: res.status, json: undefined, limited };
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_RESPONSE_CHARS) return { status: 200, json: undefined, limited };
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) return { status: 200, json: undefined, limited };
  try {
    return { status: 200, json: JSON.parse(text), limited };
  } catch {
    return { status: 200, json: undefined, limited };
  }
}

async function getJson(path: string, doFetch: FetchLike): Promise<unknown> {
  const r = await request(path, doFetch);
  return r.status === 200 && r.json !== undefined ? r.json : null;
}

// ---- validation ----

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Plain tag name only (release tags are never put into a request URL any more).
function isPlainTag(tag: unknown): tag is string {
  return typeof tag === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(tag) && !tag.includes("..");
}

function cleanText(v: string, max: number): string {
  return v
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    // Bidi overrides/isolates and zero-width characters: they reorder or hide text in the notes (Trojan Source style).
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .slice(0, max);
}

// GitHub sends null for an empty name/body; anything else that is not a string is an anomaly (undefined = invalid).
function optionalText(v: unknown, max: number): string | null {
  if (v === null) return "";
  if (typeof v !== "string") return null;
  return cleanText(v, max);
}

function toRelease(raw: unknown, upstream: string): LatestRelease | null {
  if (!isObject(raw)) return null;
  const tag = raw.tag_name;
  if (!isPlainTag(tag) || parseSemver(tag) === null) return null;
  if (raw.draft === true || raw.prerelease === true) return null;
  const name = optionalText(raw.name ?? null, 200);
  const body = optionalText(raw.body ?? null, MAX_BODY_CHARS);
  if (name === null || body === null) return null;
  const url = raw.html_url;
  if (typeof url !== "string" || url.length > 500 || /[\s\u0000-\u001F\u007F]/.test(url)) return null;
  if (!url.toLowerCase().startsWith(`https://github.com/${upstream.toLowerCase()}/`)) return null;
  if (url.includes("..") || /%2e/i.test(url)) return null; // no dot segments: the link must stay inside the upstream repo path
  const published = raw.published_at ?? null;
  if (published !== null && (typeof published !== "string" || published.length > 40)) return null;
  return { tag, version: tag.replace(/^v/, ""), name, body, url, publishedAt: published };
}

// ---- public API ----

export async function fetchLatestRelease(opts: LookupOptions = {}): Promise<LatestRelease | null> {
  const upstream = resolveUpstream(opts.env ?? process.env);
  if (!upstream) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  return cached(`release:${upstream.toLowerCase()}`, now, opts.ttlMs ?? DEFAULT_TTL_MS, async () =>
    toRelease(await getJson(`${repoPath(upstream)}/releases/latest`, doFetch), upstream),
  );
}

export const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_DEREF = 3; // lightweight tag = 0 hops; an annotated tag pointing at another tag is followed this many times

export type TagCommitResult =
  | { ok: true; sha: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unavailable"; status?: number; limited?: true };

const unavailable = (r?: Fetched): TagCommitResult => ({
  ok: false,
  reason: "unavailable",
  ...(r && r.status !== 200 ? { status: r.status } : {}),
  ...(r && r.limited ? { limited: true as const } : {}),
});

// Resolves a release tag on `upstream` to the 40-hex commit it points to (uncached). GET git/ref/tags/<tag>, then for
// an annotated tag GET git/tags/<sha> up to MAX_DEREF times. 404 on the ref = the tag does not exist (not_found);
// every other failure or shape anomaly = unavailable. `token` is only for sync time (higher rate limit than 60/h) and
// goes to api.github.com only, like every URL built here.
export async function resolveTagCommit(opts: { upstream: string; tag: string; fetch?: FetchLike; token?: string }): Promise<TagCommitResult> {
  const { upstream, tag, token } = opts;
  if (!isValidRepo(upstream) || !isPlainTag(tag)) return unavailable();
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const first = await request(`${repoPath(upstream)}/git/ref/tags/${encodeURIComponent(tag)}`, doFetch, token);
    if (first.status === 404) return { ok: false, reason: "not_found" };
    if (first.status !== 200 || !isObject(first.json)) return unavailable(first);
    if (first.json.ref !== `refs/tags/${tag}`) return unavailable();
    let obj = first.json.object;
    for (let hop = 0; ; hop++) {
      if (!isObject(obj) || typeof obj.sha !== "string" || !SHA_RE.test(obj.sha)) return unavailable();
      if (obj.type === "commit") return { ok: true, sha: obj.sha };
      if (obj.type !== "tag" || hop >= MAX_DEREF) return unavailable();
      const next = await request(`${repoPath(upstream)}/git/tags/${obj.sha}`, doFetch, token);
      if (next.status !== 200 || !isObject(next.json)) return unavailable(next);
      obj = next.json.object;
    }
  } catch {
    return unavailable();
  }
}

// Cached, unauthenticated wrapper (key tagsha:<upstream>:<tag>): the commit sha of the release tag; null when unknown.
export async function fetchTagCommit(opts: LookupOptions & { tag: string }): Promise<string | null> {
  const upstream = resolveUpstream(opts.env ?? process.env);
  if (!upstream) return null;
  const now = opts.now ?? Date.now;
  return cached(`tagsha:${upstream.toLowerCase()}:${opts.tag}`, now, opts.ttlMs ?? DEFAULT_TTL_MS, async () => {
    const r = await resolveTagCommit({ upstream, tag: opts.tag, fetch: opts.fetch });
    return r.ok ? r.sha : null;
  });
}

// Sorted, de-duplicated 14-digit migration versions in supabase/migrations at the given upstream commit (the release
// tag's commit, which is what the sync merges); null when unknown.
export async function fetchMigrationVersions(opts: LookupOptions & { sha: string }): Promise<string[] | null> {
  const upstream = resolveUpstream(opts.env ?? process.env);
  if (!upstream || !SHA_RE.test(opts.sha)) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const sha = opts.sha;
  return cached(`migrations:${upstream.toLowerCase()}:${sha}`, now, opts.ttlMs ?? DEFAULT_TTL_MS, async () => {
    const raw = await getJson(`${repoPath(upstream)}/contents/supabase/migrations?ref=${sha}`, doFetch);
    if (!Array.isArray(raw)) return null;
    const versions = new Set<string>();
    for (const item of raw) {
      if (!isObject(item) || item.type !== "file" || typeof item.name !== "string") continue;
      const m = item.name.match(/^(\d{14})_[A-Za-z0-9._-]*\.sql$/);
      if (m) versions.add(m[1]);
    }
    return [...versions].sort();
  });
}

// The migration versions bundled into the running app (comma list injected at build by next.config.ts).
// Literal `process.env.AGENCY_BOARD_MIGRATIONS` so Next can inline it. null = not injected (unknown).
export function bundledMigrations(): string[] | null {
  const raw = process.env.AGENCY_BOARD_MIGRATIONS;
  if (raw === undefined) return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

// Versions in the release TAG's tree that the running app does not have yet; null = unknown (tag unresolved, listing
// failed, or no bundled list). Never falls back to the default branch.
export async function pendingMigrationCount(
  opts: LookupOptions & { tag: string; bundled?: readonly string[] | null },
): Promise<number | null> {
  const bundled = opts.bundled !== undefined ? opts.bundled : bundledMigrations();
  if (!bundled) return null;
  const sha = await fetchTagCommit(opts);
  if (!sha) return null;
  const upstream = await fetchMigrationVersions({ ...opts, sha });
  if (!upstream) return null;
  const have = new Set(bundled);
  return upstream.filter((v) => !have.has(v)).length;
}
