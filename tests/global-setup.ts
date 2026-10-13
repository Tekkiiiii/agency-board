// Vitest globalSetup: registers a per-invocation runId registry and, on teardown, sweeps every runId that
// registered itself (tests/helpers.ts) via sweepRun(runId). Idempotent: a clean run finds nothing to delete.
// Scope is strictly this invocation's runIds (`test-<runId>-%`); other runs and real data are never matched.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "vite";

export default function setup() {
  for (const [k, v] of Object.entries(loadEnv("test", process.cwd(), ""))) if (process.env[k] === undefined) process.env[k] = v;
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
