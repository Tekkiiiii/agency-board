// Pure test-database guard (no I/O except the injected stack probe). Used by tests/global-setup.ts so
// that `npm test` can never write to or sweep a hosted database by accident.
//
// Default target is the local Supabase stack. A non-local SUPABASE_URL is refused unless the explicit
// opt-in variable below is exactly "1". The host is parsed with URL, never substring-matched.

export const REMOTE_OPT_IN = "AGENCY_BOARD_TEST_ALLOW_REMOTE";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLocalUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url.trim()) return false;
  let u: URL;
  try { u = new URL(url.trim()); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return LOCAL_HOSTS.has(u.hostname);
}

type Env = Record<string, string | undefined>;

/** Throws unless env.SUPABASE_URL is local (or the opt-in is exactly "1" and a URL is set). Never echoes keys. */
export function assertSafeTestDb(env: Env): void {
  const url = env.SUPABASE_URL;
  if (isLocalUrl(url)) return;
  if (env[REMOTE_OPT_IN] === "1" && typeof url === "string" && url.trim()) return;
  // The host is deliberately not echoed: the message is safe to paste and a grep for a hosted project ref stays clean.
  throw new Error(
    `Refusing to run the tests against a non-local database (SUPABASE_URL is unset, invalid or not 127.0.0.1 / localhost / ::1).\n` +
    `Tests write and delete rows, so they only run against the local Supabase stack by default.\n` +
    `  - Start it:   supabase start   (then re-run; the URL and keys are read from \`supabase status\`)\n` +
    `  - Or put a local SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.test.local (git-ignored)\n` +
    `  - Unset any SUPABASE_URL exported in your shell that points at a hosted project\n` +
    `  - Deliberately testing a disposable hosted project: ${REMOTE_OPT_IN}=1\n` +
    `.env.local is never read by the tests.`,
  );
}

const KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] as const;

/**
 * Final test env. Precedence: shell SUPABASE_* > env-file values (.env.test.local) > local stack probe.
 * The probe is only called when the URL or the service key is still missing. Non-SUPABASE file values
 * are returned too; the caller applies them without overriding the shell.
 */
export function resolveTestEnv(
  shell: Env,
  fileEnv: Env,
  probeStack: () => { API_URL?: string; ANON_KEY?: string; SERVICE_ROLE_KEY?: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fileEnv)) if (v !== undefined) out[k] = v;
  for (const k of KEYS) if (shell[k]) out[k] = shell[k]!;
  if (!out.SUPABASE_URL || !out.SUPABASE_SERVICE_ROLE_KEY) {
    let s: ReturnType<typeof probeStack>;
    try { s = probeStack(); } catch (e) {
      throw new Error(
        `No test database configured and the local Supabase stack is not reachable (${(e as Error).message}).\n` +
        `Run \`supabase start\` in the repo root, or set a local SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.test.local.`,
      );
    }
    out.SUPABASE_URL ||= s.API_URL ?? "";
    out.SUPABASE_ANON_KEY ||= s.ANON_KEY ?? "";
    out.SUPABASE_SERVICE_ROLE_KEY ||= s.SERVICE_ROLE_KEY ?? "";
  }
  return out;
}
