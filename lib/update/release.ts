// Upstream release + migration lookup for the in-app Update button (server-side only).
// Every call is an unauthenticated GET to the literal host https://api.github.com (no Authorization header, ever: the
// 60 req/h anonymous limit is why results are cached). Nothing from a response is ever used as a URL, host or header;
// any shape anomaly returns null, which the caller treats as "no update" (fail silent).

import { apiUrl, GITHUB_API_VERSION, repoPath, resolveUpstream } from "./config";
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

async function getJson(path: string, doFetch: FetchLike): Promise<unknown> {
  const res = await doFetch(apiUrl(path), {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "agency-board-update-check",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) return null;
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_RESPONSE_CHARS) return null;
  const text = await res.text();
  if (text.length > MAX_RESPONSE_CHARS) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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

// Sorted, de-duplicated 14-digit migration versions on the upstream DEFAULT BRANCH HEAD (no ref query: that is what
// POST merge-upstream merges, not the release tag); null when unknown.
export async function fetchMigrationVersions(opts: LookupOptions = {}): Promise<string[] | null> {
  const upstream = resolveUpstream(opts.env ?? process.env);
  if (!upstream) return null;
  const doFetch = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  return cached(`migrations:${upstream.toLowerCase()}:head`, now, opts.ttlMs ?? DEFAULT_TTL_MS, async () => {
    const raw = await getJson(`${repoPath(upstream)}/contents/supabase/migrations`, doFetch);
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

// Upstream default-branch versions the running app does not have yet; null = unknown.
export async function pendingMigrationCount(
  opts: LookupOptions & { bundled?: readonly string[] | null } = {},
): Promise<number | null> {
  const bundled = opts.bundled !== undefined ? opts.bundled : bundledMigrations();
  if (!bundled) return null;
  const upstream = await fetchMigrationVersions(opts);
  if (!upstream) return null;
  const have = new Set(bundled);
  return upstream.filter((v) => !have.has(v)).length;
}
