// Vitest globalSetup: registers a per-invocation runId registry and, on teardown, sweeps every runId that
// registered itself (tests/helpers.ts) via sweepRun(runId). Idempotent: a clean run finds nothing to delete.
// Scope is strictly this invocation's runIds (`test-<runId>-%`); other runs and real data are never matched.
//
// DB safety (runs first, before any DB or network call): the test env is built here, never from .env.local.
// Precedence for SUPABASE_*: shell > .env.test.local (git-ignored, optional) > `supabase status` of the local stack.
// The final SUPABASE_URL must be local (tests/db-guard.ts) or the run aborts; opt-in for a disposable hosted DB: AGENCY_BOARD_TEST_ALLOW_REMOTE=1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { assertSafeTestDb, resolveTestEnv } from "./db-guard";

function probeLocalStack() {
  const attempts: [string, string[]][] = [["supabase", ["status", "-o", "env"]], ["npx", ["--no-install", "supabase", "status", "-o", "env"]]];
  let last: unknown;
  for (const [cmd, args] of attempts) {
    try { return parseEnv(execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 })); } catch (e) { last = e; }
  }
  throw new Error(`\`supabase status\` failed: ${(last as Error)?.message?.split("\n")[0] ?? last}`);
}

export default function setup() {
  const envFile = join(process.cwd(), ".env.test.local");
  const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const resolved = resolveTestEnv(process.env, fileEnv, probeLocalStack);
  for (const [k, v] of Object.entries(resolved)) if (process.env[k] === undefined || k.startsWith("SUPABASE_")) process.env[k] = v;
  assertSafeTestDb(process.env);
  const dir = mkdtempSync(join(tmpdir(), "hub-test-runs-"));
  const file = join(dir, "runs.txt");
  process.env.AGENCY_BOARD_TEST_RUNS_FILE = file;
  return async () => {
    let ids: string[] = [];
    try { ids = [...new Set(readFileSync(file, "utf8").split("\n").map((x) => x.trim()).filter((x) => /^[a-z0-9]{6,}$/.test(x)))]; } catch { /* none */ }
    if (ids.length) {
      const { sweepRun } = await import("./helpers");
      for (const id of ids) { try { await sweepRun(id); } catch (e) { console.error("global teardown sweep failed", id, (e as any)?.message ?? e); } }
    }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  };
}
