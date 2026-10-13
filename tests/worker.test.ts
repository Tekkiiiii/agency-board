import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { WORKER_MJS } from "../lib/scripts/workerMjs";

// Hermetic unit tests for the codex auto-worker (CONTRACT §19): fake REST api, fake codex process.
// The worker source is the served string itself, written to a temp .mjs and imported.

let W: any;
let root: string;
let home: string;
let work: string;
const ME = "codex@laptop";
const BOSS = "claude@work-pc";
const DIRECTOR = "claude@laptop";

// Real git helper (temp dirs only). Identity passed per call so the test never needs a global git identity.
const GI = ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", [...GI, ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
  return r.stdout.trim();
};
function mkRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "--allow-empty", "-q", "-m", "init");
  return realpathSync(dir);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hub-worker-test-")));
  home = join(root, "home");
  work = join(root, "work", "scratch");
  mkdirSync(home, { recursive: true });
  work = mkRepo(work); // mapped folders must be a clean git repo root
  const f = join(root, "worker.mjs");
  writeFileSync(f, WORKER_MJS);
  W = await import(pathToFileURL(f).href);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const task = (extra: Record<string, unknown> = {}) => ({
  id: randomUUID(), status: "open", namespace: "project/demo", title: "do the thing", body: "details",
  handoff_to: ME, assigned_by: BOSS, created_at: new Date().toISOString(), ...extra,
});

function cfg(extra: Record<string, unknown> = {}) {
  return W.loadConfig(
    { base_url: "http://127.0.0.1:9", identity: ME, allow_assigned_by: [BOSS], folders: { "project/demo": work }, default_workdir_root: join(root, "workdirs"),
      codex_bin: "/fake/codex", runs_dir: join(root, "runs"), poll_seconds: 0.01, heartbeat_seconds: 0.01, heartbeat_min_seconds: 0.001, ...extra },
    {}, home);
}

type Flags = { dispatchPaused?: boolean; writesFrozen?: boolean };
function fakeApi(tasks: any[], o: { flags?: () => Flags; guard422?: boolean; guard422Always?: boolean; approval?: string } = {}) {
  const calls: any[][] = [];
  const api = {
    listMine: async () => { calls.push(["list"]); return { tasks, dispatch_paused: false }; },
    claim: async (id: string) => { calls.push(["claim", id]); return { id, status: "claimed" }; },
    heartbeat: async (b: any) => { calls.push(["heartbeat", b]); return { ok: true, flags: o.flags ? o.flags() : {} }; },
    // PATCH /tasks/:id: release (open), blocked, or the final failed fallback. Never carries a result any more.
    update: async (id: string, b: any) => { calls.push(["update", id, b]); return { id }; },
    // POST /tasks/:id/complete: the single atomic close + notify. The guard rejects any result with content.
    complete: async (id: string, b: any) => {
      calls.push(["complete", id, b]);
      if (o.guard422Always) throw new W.ApiErr(422, "CUSTOMER_PII_BLOCKED");
      if (o.guard422 && b.result && !b.result.withheld) throw new W.ApiErr(422, "CUSTOMER_PII_BLOCKED");
      return { id, status: b.status };
    },
    requestApproval: async (b: any) => { calls.push(["approval", b]); return { id: "appr-1", status: "pending" }; },
    getApproval: async (id: string) => { calls.push(["get_approval", id]); return { id, status: o.approval ?? "pending" }; },
  };
  const of = (k: string) => calls.filter((c) => c[0] === k);
  return { api, calls, of };
}

// mode ok: writes the -o file then exits 0; hang: never exits until killed.
function fakeSpawn(mode: "ok" | "hang" | "fail", lastMessage = "Edited a.txt, committed locally.") {
  const spawned: any[] = [];
  const killed: string[] = [];
  const spawn = (bin: string, args: string[], opts: any) => {
    spawned.push({ bin, args, opts });
    const ch: any = new EventEmitter();
    ch.stdin = { on() {}, end() {} };
    ch.kill = (sig: string) => { killed.push(sig); setImmediate(() => ch.emit("exit", null, sig)); };
    if (mode !== "hang") {
      setImmediate(() => {
        writeFileSync(args[args.indexOf("-o") + 1], lastMessage);
        ch.emit("exit", mode === "ok" ? 0 : 1, null);
      });
    }
    return ch;
  };
  return { spawn, spawned, killed };
}

// Scriptable fake for the worker's git calls (args come prefixed with the hardening flags).
// status: the 1st call is the pre-claim clean check (o.pre, default clean); later calls (after codex) return o.dirty.
function fakeGit(o: { repo?: boolean; top?: string; pre?: string; dirty?: string; commitFails?: boolean; ahead?: string; url?: string; pushOk?: boolean } = {}) {
  const calls: any[] = [];
  let statuses = 0;
  const execFile = async (bin: string, args: string[], opts: any) => {
    calls.push({ bin, args, opts });
    const sub = args.filter((a, k) => a !== "-c" && args[k - 1] !== "-c")[0];
    switch (sub) {
      case "rev-parse":
        if (args.includes("--show-toplevel")) return { ok: o.repo !== false, stdout: o.repo === false ? "" : (o.top ?? work) + "\n" };
        return args.includes("--is-inside-work-tree") ? { ok: o.repo !== false, stdout: o.repo === false ? "" : "true\n" } : { ok: true, stdout: "abc123\n" };
      case "status": return { ok: true, stdout: statuses++ === 0 ? (o.pre ?? "") : (o.dirty ?? "") };
      case "add": return { ok: true, stdout: "" };
      case "commit": return { ok: !o.commitFails, stdout: "" };
      case "remote": return { ok: o.url !== "", stdout: (o.url ?? "https://git.example/repo.git") + "\n" };
      case "rev-list": return { ok: true, stdout: (o.ahead ?? "1") + "\n" };
      case "push": return { ok: o.pushOk !== false, stdout: "" };
      default: return { ok: true, stdout: "" };
    }
  };
  const subs = () => calls.map((c) => c.args.filter((a: string, k: number) => a !== "-c" && c.args[k - 1] !== "-c")[0]);
  return { calls, execFile, subs };
}

describe("worker claim rule", () => {
  it("ignores unassigned (handoff_to null) and other-target tasks: never claims them", async () => {
    const f = fakeApi([
      task({ handoff_to: null, assigned_by: null, namespace: "project/acme" }),
      task({ handoff_to: null }),
      task({ handoff_to: "claude" }),
      task({ handoff_to: "codex@other-mac" }),
      task({ handoff_to: ME, status: "claimed" }),
    ]);
    const sp = fakeSpawn("ok");
    const w = W.createWorker({ cfg: cfg(), api: f.api, spawn: sp.spawn, home });
    expect(await w.tick()).toEqual({ idle: true });
    expect(f.of("claim")).toHaveLength(0);
    expect(sp.spawned).toHaveLength(0);
    expect(W.isForMe(task({ handoff_to: null }), ME)).toBe(false);
    expect(W.isForMe(task({ handoff_to: "codex" }), ME)).toBe(true);
    expect(W.isForMe(task({ handoff_to: ME }), ME)).toBe(true);
    expect(W.isForMe(task({ handoff_to: ME, status: "blocked" }), ME)).toBe(false); // never claims blocked
  });

  it("refuses a non-allowlisted assigner without claiming", async () => {
    const f = fakeApi([task({ assigned_by: "claude@someone-else" }), task({ assigned_by: null, handoff_to: "codex" })]);
    const w = W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok").spawn, home });
    expect(await w.tick()).toEqual({ idle: true });
    expect(f.of("claim")).toHaveLength(0);
  });
});

describe("worker folder mapping", () => {
  it("unmapped namespace with default_workdirs:false: claims, does not run codex, PATCHes blocked to assigned_by with the reason", async () => {
    const t = task({ namespace: "project/unmapped" });
    const f = fakeApi([t]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ default_workdirs: false }), api: f.api, spawn: sp.spawn, home }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "BLOCKED" });
    expect(f.of("claim")).toHaveLength(1);
    expect(sp.spawned).toHaveLength(0);
    expect(f.of("update")).toHaveLength(1);
    expect(f.of("update")[0][1]).toBe(t.id);
    expect(f.of("update")[0][2]).toMatchObject({ status: "blocked", to: BOSS });
    expect(f.of("update")[0][2].note).toMatch(/^namespace project\/unmapped is not mapped/);
    expect(f.of("update")[0][2].result).toBeUndefined();
    expect(f.of("complete")).toHaveLength(0);
  });

  it("codex CLI not found: claims, no codex run, ONE PATCH blocked to assigned_by naming codex, no complete", async () => {
    const t = task();
    const f = fakeApi([t]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: sp.spawn, home, resolveBin: () => "" }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "BLOCKED" });
    expect(f.of("claim")).toHaveLength(1);
    expect(sp.spawned).toHaveLength(0);
    expect(f.of("update")).toHaveLength(1);
    expect(f.of("update")[0][1]).toBe(t.id);
    expect(f.of("update")[0][2]).toEqual({ status: "blocked", to: BOSS, note: "codex CLI not found on the worker machine" });
    expect(f.of("complete")).toHaveLength(0);
  });

  it("never maps to $HOME, a parent of $HOME, or a relative path", () => {
    expect(W.mapFolder("project/a", { "project/a": home }, home)).toMatchObject({ ok: false });
    expect(W.mapFolder("project/a", { "project/a": root }, home)).toMatchObject({ ok: false });
    expect(W.mapFolder("project/a", { "project/a": "/" }, home)).toMatchObject({ ok: false });
    expect(W.mapFolder("project/a", { "project/a": "rel/dir" }, home)).toMatchObject({ ok: false });
    expect(W.mapFolder("project/a", { "*": work }, home)).toMatchObject({ ok: false });
    expect(W.mapFolder("project/a/b", { "project/*": "/nope", "project/a/*": work }, home)).toMatchObject({ ok: true, folder: work });
  });
});

describe("worker codex run", () => {
  it("runs codex exec sandboxed in the mapped folder, secrets stripped, ONE complete with notify=assigned_by", async () => {
    const t = task();
    const f = fakeApi([t]);
    const sp = fakeSpawn("ok");
    const env = { PATH: "/usr/bin", HOME: home, AGENCY_BOARD_TOKEN_CODEX: "agency-board_codex_FAKE_secret", OPENAI_API_KEY: "sk-x" };
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: sp.spawn, home, env, execFile: fakeGit().execFile }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "DONE" });
    const s = sp.spawned[0];
    expect(s.bin).toBe("/fake/codex");
    expect(s.opts.cwd).toBe(work);
    expect(s.args.slice(0, 3)).toEqual(["exec", "--sandbox", "workspace-write"]);
    expect(s.args).toContain("sandbox_workspace_write.network_access=false");
    expect(s.args).toContain("--ignore-user-config");
    expect(s.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(s.args[s.args.indexOf("-C") + 1]).toBe(work);
    expect(s.opts.env).toEqual({ PATH: "/usr/bin", HOME: home });
    expect(f.of("complete")).toHaveLength(1);
    expect(f.of("update")).toHaveLength(0); // no PATCH-result any more
    const c = f.of("complete")[0];
    expect(c[1]).toBe(t.id);
    expect(c[2]).toMatchObject({ completion_key: "worker:" + t.id, status: "done", notify: BOSS });
    expect(c[2].note).toContain("Edited a.txt");
    expect(c[2].result).toMatchObject({ exit_code: 0, worker: ME, approvals: [] });
  });

  it("codex exits non-zero: ONE complete with status failed + notify", async () => {
    const t = task();
    const f = fakeApi([t]);
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("fail", "could not build").spawn, home, execFile: fakeGit().execFile }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "FAILED" });
    expect(f.of("complete")).toHaveLength(1);
    const c = f.of("complete")[0][2];
    expect(c).toMatchObject({ completion_key: "worker:" + t.id, status: "failed", notify: BOSS });
    expect(c.note).toMatch(/^FAILED: could not build/);
    expect(c.result).toMatchObject({ exit_code: 1 });
    expect(f.of("update")).toHaveLength(0);
  });

  it("timeout: kills codex and completes the task failed with notify", async () => {
    const t = task();
    const f = fakeApi([t]);
    const sp = fakeSpawn("hang");
    const r = await W.createWorker({ cfg: cfg({ timeout_minutes: 0.001, heartbeat_seconds: 10 }), api: f.api, spawn: sp.spawn, home }).tick();
    expect(r).toEqual({ status: "timeout" });
    expect(sp.killed[0]).toBe("SIGTERM");
    expect(f.of("complete")).toHaveLength(1);
    expect(f.of("update")).toHaveLength(0);
    const u = f.of("complete")[0][2];
    expect(u).toMatchObject({ completion_key: "worker:" + t.id, status: "failed", notify: BOSS });
    expect(u.note).toMatch(/timeout/);
    expect(u.result).toMatchObject({ timeout: true, worker: ME });
  });

  it("heartbeats while codex runs (renews the lease)", async () => {
    const f = fakeApi([task()]);
    const sp = fakeSpawn("hang");
    await W.createWorker({ cfg: cfg({ timeout_minutes: 0.002 }), api: f.api, spawn: sp.spawn, home }).tick();
    expect(f.of("heartbeat").some((c) => c[1].task_id && c[1].status_note === "codex running")).toBe(true);
  });
});

describe("worker kill switch", () => {
  it.each([["dispatchPaused"], ["writesFrozen"]])("%s before claim: no list, no claim", async (k) => {
    const f = fakeApi([task()], { flags: () => ({ [k]: true }) });
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok").spawn, home }).tick();
    expect(r.skipped).toBeTruthy();
    expect(f.of("list")).toHaveLength(0);
    expect(f.of("claim")).toHaveLength(0);
  });

  it("flipped mid-run: kills codex and releases the claim", async () => {
    let paused = false;
    const f = fakeApi([task()], { flags: () => ({ dispatchPaused: paused }) });
    const sp = fakeSpawn("hang");
    const w = W.createWorker({ cfg: cfg({ timeout_minutes: 1 }), api: f.api, spawn: sp.spawn, home });
    const p = w.tick();
    for (let k = 0; k < 400 && !sp.spawned.length; k++) await new Promise((r) => setTimeout(r, 10)); // pre-claim git checks take real time
    paused = true;
    expect(await p).toEqual({ stopped: "dispatch_paused" });
    expect(sp.killed[0]).toBe("SIGTERM");
    expect(f.of("update")[0][2]).toMatchObject({ status: "open" }); // release stays a PATCH open
    expect(f.of("complete")).toHaveLength(0);
  });
});

describe("worker approval gate (outward actions)", () => {
  const PUSH_MSG = "Committed fix locally.\nOUTWARD: git push origin main";

  it("AUTO_PUSH=false (default): a push request becomes a pending approval, never a push", async () => {
    const f = fakeApi([task()]);
    const fg = fakeGit();
    const c = cfg();
    expect(c.auto_push).toBe(false);
    const r = await W.createWorker({ cfg: c, api: f.api, spawn: fakeSpawn("ok", PUSH_MSG).spawn, home, execFile: fg.execFile }).tick();
    expect(f.of("approval")).toHaveLength(1);
    expect(f.of("approval")[0][1]).toMatchObject({ options: ["approved", "denied"] });
    expect(f.of("get_approval")).toHaveLength(0);
    expect(fg.subs()).not.toContain("push");
    expect(r.approvals).toEqual([{ action: "git push origin main", approval_id: "appr-1", status: "pending", executed: false }]);
  });

  it("AUTO_PUSH=true + approved: pushes only after the decision", async () => {
    const f = fakeApi([task()], { approval: "approved" });
    const fg = fakeGit();
    const r = await W.createWorker({ cfg: cfg({ auto_push: true }), api: f.api, spawn: fakeSpawn("ok", PUSH_MSG).spawn, home, execFile: fg.execFile }).tick();
    const pushes = fg.calls.filter((c) => c.args.includes("push"));
    expect(pushes).toHaveLength(1);
    expect(pushes[0].bin).toBe("git");
    expect(pushes[0].args).toEqual([...W.GIT_SAFE, "push", "origin", "main"]);
    expect(pushes[0].args).toContain("core.hooksPath=/dev/null");
    expect(pushes[0].opts.cwd).toBe(work);
    expect(r.approvals[0]).toMatchObject({ status: "approved", executed: true });
  });

  it("AUTO_PUSH=true + denied: no push; non-push outward actions are never executed", async () => {
    const f = fakeApi([task()], { approval: "denied" });
    const fg = fakeGit();
    const msg = "done\nOUTWARD: git push origin main\nOUTWARD: email the client\nOUTWARD: git push origin main; rm -rf /";
    const r = await W.createWorker({ cfg: cfg({ auto_push: true }), api: f.api, spawn: fakeSpawn("ok", msg).spawn, home, execFile: fg.execFile }).tick();
    expect(fg.subs()).not.toContain("push");
    expect(f.of("approval")).toHaveLength(3);
    expect(r.approvals.map((a: any) => a.status)).toEqual(["denied", "pending", "pending"]);
    expect(W.PUSH_RE.test("git push origin main; rm -rf /")).toBe(false);
    expect(W.AUTO_PUSH).toBeUndefined();
    expect(W.loadConfig({ base_url: "https://x.example", identity: ME }, { AUTO_PUSH: "true" }, home).auto_push).toBe(true);
  });
});

describe("worker commits for codex (git read-only in sandbox)", () => {
  const PUSH_MSG = "Wrote HELLO.md.\nOUTWARD: git push origin main";
  const run = (fg: any, f: any, extra: Record<string, unknown> = {}, msg = "Wrote HELLO.md.") =>
    W.createWorker({ cfg: cfg(extra), api: f.api, spawn: fakeSpawn("ok", msg).spawn, home, execFile: fg.execFile }).tick();

  it("prompt tells codex it cannot commit", () => {
    const p = W.buildPrompt(task(), ME);
    expect(p).toContain("CANNOT run git commit");
    expect(p).not.toContain("make LOCAL git commits");
  });

  it("dirty tree: worker commits with hooks disabled and the worker identity", async () => {
    const t = task({ title: "x".repeat(100) });
    const f = fakeApi([t]);
    const fg = fakeGit({ dirty: " M a.txt\n?? HELLO.md\n" });
    const r = await run(fg, f);
    expect(r).toMatchObject({ status: "DONE" });
    expect(fg.subs()).toEqual(["rev-parse", "status", "rev-parse", "status", "add", "commit", "rev-parse"]);
    const add = fg.calls.find((c) => c.args.includes("add"))!;
    expect(add.args.slice(W.GIT_SAFE.length)).toEqual(["add", "-A", "--", "."]); // scoped pathspec, never the whole repo
    expect(add.opts.cwd).toBe(work);
    for (const c of fg.calls) {
      expect(c.args.slice(0, 6)).toEqual(W.GIT_SAFE);
      expect(c.args).toContain("core.hooksPath=/dev/null");
      expect(c.args).toContain("protocol.ext.allow=never");
    }
    const cm = fg.calls.find((c) => c.args.includes("commit"))!;
    expect(cm.args).toContain("user.name=" + ME);
    expect(cm.args).toContain("user.email=" + ME);
    expect(cm.args[cm.args.indexOf("-m") + 1]).toBe("x".repeat(72) + " (agency-board task " + t.id + ")");
    expect(f.of("complete")[0][2].result.commit).toEqual({ sha: "abc123", files_changed: 2 });
  });

  it("clean tree: commit skipped, no push approval filed", async () => {
    const f = fakeApi([task()]);
    const fg = fakeGit({ dirty: "", ahead: "0" });
    await run(fg, f, {}, PUSH_MSG);
    expect(fg.subs()).not.toContain("commit");
    expect(f.of("complete")[0][2].result.commit).toMatchObject({ skipped: expect.stringContaining("clean") });
    expect(f.of("approval")).toHaveLength(0);
    expect(f.of("complete")[0][2].result.notes[0]).toContain("nothing ahead");
  });

  it("not a git repo: blocked before codex runs, nothing committed", async () => {
    const f = fakeApi([task()]);
    const fg = fakeGit({ repo: false });
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: sp.spawn, home, execFile: fg.execFile }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "BLOCKED" });
    expect(sp.spawned).toHaveLength(0);
    expect(f.of("update")[0][2]).toMatchObject({ status: "blocked", to: BOSS });
    expect(f.of("update")[0][2].note).toMatch(/not a git repository/);
    expect(fg.subs()).not.toContain("add");
    expect(fg.subs()).not.toContain("commit");
  });

  it("commit failure: FAILED hand-back, no approvals filed", async () => {
    const f = fakeApi([task()]);
    const fg = fakeGit({ dirty: "?? a\n", commitFails: true });
    const r = await run(fg, f, {}, PUSH_MSG);
    expect(r).toMatchObject({ status: "FAILED" });
    expect(f.of("approval")).toHaveLength(0);
    expect(f.of("complete")[0][2]).toMatchObject({ status: "failed", notify: BOSS });
    expect(f.of("complete")[0][2].note).toContain("FAILED");
    expect(f.of("complete")[0][2].result.commit.failed).toContain("commit");
  });

  it("approval question carries the remote URL (credentials redacted)", async () => {
    const f = fakeApi([task()]);
    const fg = fakeGit({ dirty: "?? a\n", url: "https://user:tok@git.example/o/r.git" });
    await run(fg, f, {}, PUSH_MSG);
    const q = f.of("approval")[0][1].question;
    expect(q).toContain("git push origin main");
    expect(q).toContain("https://git.example/o/r.git");
    expect(q).not.toContain("tok");
  });
});

describe("worker accepts the director by role (default) plus extra allow_assigned_by", () => {
  const dTask = (extra: Record<string, unknown> = {}) => task({ assigned_by: DIRECTOR, assigned_by_role: "director", ...extra });

  it("isAllowed: director role accepted with an EMPTY allowlist; lead/member/unknown refused; allowlist still works", () => {
    const c = cfg({ allow_assigned_by: [] });
    expect(c.accept_director).toBe(true);
    expect(W.isAllowed(dTask(), c)).toBe(true);
    expect(W.isAllowed(task({ assigned_by: "claude@x", assigned_by_role: "lead" }), c)).toBe(false);
    expect(W.isAllowed(task({ assigned_by: "claude@x", assigned_by_role: "member" }), c)).toBe(false);
    expect(W.isAllowed(task({ assigned_by: "claude@x", assigned_by_role: null }), c)).toBe(false);
    expect(W.isAllowed(task({ assigned_by: "claude@x" }), c)).toBe(false); // older server: no role field
    expect(W.isAllowed(dTask({ assigned_by: null }), c)).toBe(false);
    // extra assigner on the allowlist is accepted whatever its role
    expect(W.isAllowed(task({ assigned_by: BOSS, assigned_by_role: "lead" }), cfg({ allow_assigned_by: [BOSS] }))).toBe(true);
    // the identity is not hardcoded: any identity the server says is director
    expect(W.isAllowed(dTask({ assigned_by: "claude@another-director" }), c)).toBe(true);
  });

  it("accept_director:false refuses the director (unless allowlisted)", () => {
    const c = cfg({ allow_assigned_by: [], accept_director: false });
    expect(c.accept_director).toBe(false);
    expect(W.isAllowed(dTask(), c)).toBe(false);
    expect(W.isAllowed(dTask(), cfg({ allow_assigned_by: [DIRECTOR], accept_director: false }))).toBe(true);
  });

  it("tick: a director task is claimed and run with no allowlist; a lead task is not claimed", async () => {
    const d = dTask();
    const f = fakeApi([task({ assigned_by: "claude@lead-box", assigned_by_role: "lead" }), d]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ allow_assigned_by: [] }), api: f.api, spawn: sp.spawn, home }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "DONE" });
    expect(f.of("claim")).toEqual([["claim", d.id]]);
    expect(f.of("complete")[0][2]).toMatchObject({ status: "done", notify: DIRECTOR });
  });

  it("tick: accept_director:false leaves the director task unclaimed", async () => {
    const f = fakeApi([dTask()]);
    const sp = fakeSpawn("ok");
    expect(await W.createWorker({ cfg: cfg({ allow_assigned_by: [], accept_director: false }), api: f.api, spawn: sp.spawn, home }).tick()).toEqual({ idle: true });
    expect(f.of("claim")).toHaveLength(0);
    expect(sp.spawned).toHaveLength(0);
  });

  it("config defaults + validation; the startup log line shows accept_director", () => {
    const c = W.loadConfig({ base_url: "https://x.example", identity: ME }, {}, home);
    expect(c).toMatchObject({ accept_director: true, default_workdirs: true, default_workdir_root: join(home, ".agency-board", "workdirs") });
    expect(W.loadConfig({ base_url: "https://x.example", identity: ME, accept_director: false, default_workdirs: false }, {}, home)).toMatchObject({ accept_director: false, default_workdirs: false });
    expect(() => W.loadConfig({ base_url: "https://x.example", identity: ME, default_workdir_root: "rel/dir" }, {}, home)).toThrow(/absolute/);
    expect(WORKER_MJS).toContain('" accept_director=" + cfg.accept_director');
  });
});

describe("worker default workdirs for unmapped namespaces", () => {
  const dTask = (ns: string) => task({ namespace: ns, assigned_by: DIRECTOR, assigned_by_role: "director" });
  const env = () => ({ PATH: process.env.PATH ?? "/usr/bin", HOME: home }); // temp HOME: no global git identity at all

  it("safeNsDir: [a-z0-9._-], '/' -> '__', rejects '..', empty and hidden names", () => {
    expect(W.safeNsDir("project/acme-x")).toBe("project__acme-x");
    expect(W.safeNsDir("Shared/My App!")).toBe("shared__my_app_");
    for (const bad of ["", "..", "a/../b", "a/..", ".hidden", "/", null, "x".repeat(201)]) expect(W.safeNsDir(bad as any)).toBeNull();
  });

  it("creates <root>/<ns> as its own repo root (no global git identity), runs codex there, commits the result", async () => {
    const wroot = join(root, "wd-ok");
    const t = dTask("project/Fresh-One");
    const f = fakeApi([t]);
    const spawned: string[] = [];
    const spawn = (bin: string, args: string[], opts: any) => {
      spawned.push(opts.cwd);
      writeFileSync(join(opts.cwd, "HELLO.md"), "hi");
      const ch: any = new EventEmitter();
      ch.stdin = { on() {}, end() {} };
      setImmediate(() => { writeFileSync(args[args.indexOf("-o") + 1], "wrote HELLO.md"); ch.emit("exit", 0, null); });
      return ch;
    };
    const r = await W.createWorker({ cfg: cfg({ folders: {}, allow_assigned_by: [], default_workdir_root: wroot }), api: f.api, spawn, home, env: env() }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "DONE" });
    const dir = join(realpathSync(wroot), "project__fresh-one");
    expect(spawned).toEqual([dir]);
    expect(git(dir, "rev-parse", "--show-toplevel")).toBe(dir); // own repo root
    expect(git(dir, "rev-list", "--count", "HEAD")).toBe("2"); // empty initial commit + the worker's commit
    expect(git(dir, "log", "-1", "--format=%ae")).toBe(ME);
    expect(git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("HELLO.md");
    expect(git(dir, "status", "--porcelain")).toBe("");
    expect(f.of("update")).toHaveLength(0);
  });

  it("re-using an existing default workdir that is clean works (second task, same namespace)", async () => {
    const wroot = join(root, "wd-reuse");
    for (let k = 0; k < 2; k++) {
      const f = fakeApi([dTask("project/again")]);
      const r = await W.createWorker({ cfg: cfg({ folders: {}, default_workdir_root: wroot }), api: f.api, spawn: fakeSpawn("ok").spawn, home, env: env() }).tick();
      expect(r).toMatchObject({ status: "DONE" });
    }
  });

  it("default_workdir_root inside a git work tree: blocked back to the assigner, nothing created", async () => {
    const repo = mkRepo(join(root, "outer-repo"));
    const f = fakeApi([dTask("project/x")]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ folders: {}, default_workdir_root: join(repo, "wd") }), api: f.api, spawn: sp.spawn, home, env: env() }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "BLOCKED" });
    expect(sp.spawned).toHaveLength(0);
    expect(f.of("update")[0][2]).toMatchObject({ status: "blocked", to: DIRECTOR });
    expect(f.of("update")[0][2].note).toMatch(/inside a git work tree/);
    expect(existsSync(join(repo, "wd", "project__x"))).toBe(false);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("default_workdir_root under ~/.claude: blocked before anything is created", async () => {
    const wroot = join(home, ".claude", "wd");
    const f = fakeApi([dTask("project/x")]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ folders: {}, default_workdir_root: wroot }), api: f.api, spawn: sp.spawn, home, env: env() }).tick();
    expect(r).toMatchObject({ status: "BLOCKED" });
    expect(f.of("update")[0][2].note).toMatch(/~\/\.claude/);
    expect(sp.spawned).toHaveLength(0);
    expect(existsSync(wroot)).toBe(false);
  });

  it("an unsafe namespace name is blocked, not mapped to a path", async () => {
    const f = fakeApi([dTask("project/../escape")]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ folders: {}, default_workdir_root: join(root, "wd-unsafe") }), api: f.api, spawn: sp.spawn, home, env: env() }).tick();
    expect(r).toMatchObject({ status: "BLOCKED" });
    expect(f.of("update")[0][2].note).toMatch(/safe default folder name/);
    expect(sp.spawned).toHaveLength(0);
  });
});

describe("worker safe commits: repo root + clean tree + never ~/.claude", () => {
  const blockedWith = async (folder: string, re: RegExp) => {
    const t = task();
    const f = fakeApi([t]);
    const sp = fakeSpawn("ok");
    const r = await W.createWorker({ cfg: cfg({ folders: { "project/demo": folder } }), api: f.api, spawn: sp.spawn, home }).tick();
    expect(r).toMatchObject({ handed_back: true, status: "BLOCKED" });
    expect(f.of("claim")).toHaveLength(1); // the server only lets the claimer block back to the assigner
    expect(sp.spawned).toHaveLength(0); // codex never ran
    expect(f.of("update")[0][2]).toMatchObject({ status: "blocked", to: BOSS });
    expect(f.of("update")[0][2].note).toMatch(re);
    expect(f.of("complete")).toHaveLength(0);
  };

  it("mapped folder that is a SUBDIR of a repo: blocked, parent repo gets no commit", async () => {
    const parent = mkRepo(join(root, "parent-repo"));
    mkdirSync(join(parent, "sub"), { recursive: true });
    writeFileSync(join(parent, "unrelated.txt"), "someone else's work"); // dirty parent: must stay untouched
    const before = git(parent, "rev-parse", "HEAD");
    await blockedWith(join(parent, "sub"), /not its root/);
    expect(git(parent, "rev-parse", "HEAD")).toBe(before);
    expect(git(parent, "rev-list", "--count", "HEAD")).toBe("1");
    expect(git(parent, "status", "--porcelain")).toBe("?? unrelated.txt");
  });

  it("dirty mapped repo: blocked with the uncommitted-changes reason, nothing committed", async () => {
    const repo = mkRepo(join(root, "dirty-repo"));
    writeFileSync(join(repo, "wip.txt"), "wip");
    await blockedWith(repo, /uncommitted changes/);
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("1");
  });

  it("mapped folder that is not a git repo at all: blocked", async () => {
    const plain = join(root, "plain-dir");
    mkdirSync(plain, { recursive: true });
    await blockedWith(realpathSync(plain), /not a git repository/);
  });

  it("mapped folder under ~/.claude: refused by mapFolder, task blocked", async () => {
    const inClaude = join(home, ".claude", "proj");
    mkRepo(inClaude);
    expect(W.mapFolder("project/demo", { "project/demo": inClaude }, home)).toMatchObject({ ok: false, reason: expect.stringContaining("~/.claude") });
    expect(W.mapFolder("project/demo", { "project/demo": join(home, ".claude") }, home)).toMatchObject({ ok: false });
    await blockedWith(inClaude, /~\/\.claude/);
  });

  it("a clean repo root is accepted and the real commit is scoped to it", async () => {
    const repo = mkRepo(join(root, "good-repo"));
    const f = fakeApi([task()]);
    const spawn = (bin: string, args: string[], opts: any) => {
      writeFileSync(join(opts.cwd, "out.txt"), "x");
      const ch: any = new EventEmitter();
      ch.stdin = { on() {}, end() {} };
      setImmediate(() => { writeFileSync(args[args.indexOf("-o") + 1], "done"); ch.emit("exit", 0, null); });
      return ch;
    };
    const r = await W.createWorker({ cfg: cfg({ folders: { "project/demo": repo } }), api: f.api, spawn, home, env: { PATH: process.env.PATH ?? "/usr/bin", HOME: home } }).tick();
    expect(r).toMatchObject({ status: "DONE" });
    expect(git(repo, "show", "--name-only", "--format=", "HEAD")).toBe("out.txt");
    expect(f.of("complete")[0][2].result.commit).toMatchObject({ files_changed: 1 });
  });
});

describe("worker write guard", () => {
  it("guard 422 on the result: metadata-only complete (withheld + code), content not resent", async () => {
    const t = task();
    const f = fakeApi([t], { guard422: true });
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok", "customer data 0901234567").spawn, home }).tick();
    expect(r).toMatchObject({ handed_back: false, status: "guard_rejected", code: "CUSTOMER_PII_BLOCKED" });
    const cs = f.of("complete");
    expect(cs).toHaveLength(2); // the rejected attempt, then the metadata-only one (no stripped retry of content)
    expect(cs[0][2].result.summary).toContain("0901234567");
    const meta = cs[1][2];
    expect(meta).toMatchObject({ completion_key: "worker:" + t.id, status: "failed", notify: BOSS, result: { withheld: true, code: "CUSTOMER_PII_BLOCKED" } });
    expect(meta.note).toBe("result rejected by the write guard (CUSTOMER_PII_BLOCKED); content withheld");
    expect(JSON.stringify(meta)).not.toContain("0901234567");
    expect(f.of("update")).toHaveLength(0);
  });

  it("guard 422 on the metadata-only complete too: final fallback PATCH failed with the note", async () => {
    const f = fakeApi([task()], { guard422Always: true });
    const r = await W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok", "customer data 0901234567").spawn, home }).tick();
    expect(r).toMatchObject({ status: "guard_rejected" });
    expect(f.of("complete")).toHaveLength(2);
    expect(f.of("update")).toHaveLength(1);
    expect(f.of("update")[0][2]).toEqual({ status: "failed", note: "result rejected by the write guard (CUSTOMER_PII_BLOCKED); content withheld" });
  });
});

describe("worker config + REST client", () => {
  it("rejects a placeholder identity and a non-http base", () => {
    expect(() => W.loadConfig({ base_url: "https://x.example", identity: "codex@CHANGE-ME" }, {}, home)).toThrow(/identity/);
    expect(() => W.loadConfig({ base_url: "file:///x", identity: ME }, {}, home)).toThrow(/base_url/);
  });

  it("uses mine=1 + status=open, bearer token, and surfaces the server error code", async () => {
    const seen: any[] = [];
    const fetchStub = async (url: string, init: any) => {
      seen.push([url, init]);
      if (url.includes("/claim")) return new Response(JSON.stringify({ error: { code: "CONFLICT", message: "x" } }), { status: 409 });
      return new Response(JSON.stringify({ data: { tasks: [], dispatch_paused: false } }), { status: 200 });
    };
    const api = W.makeApi("https://board.example", "agency-board_codex_FAKE_x", fetchStub);
    expect(await api.listMine()).toEqual({ tasks: [], dispatch_paused: false });
    expect(seen[0][0]).toBe("https://board.example/api/v1/tasks?mine=1&status=open&stale=peek"); // peek: the worker only logs the stale alert, a human-facing hook still gets it
    expect(seen[0][1].headers.authorization).toBe("Bearer agency-board_codex_FAKE_x");
    await expect(api.claim("t1")).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
  });

  it("complete posts to /tasks/:id/complete; update PATCHes /tasks/:id; no handoff client method", async () => {
    const seen: any[] = [];
    const fetchStub = async (url: string, init: any) => { seen.push([url, init]); return new Response(JSON.stringify({ data: { id: "t1" } }), { status: 200 }); };
    const api = W.makeApi("https://board.example", "agency-board_codex_FAKE_x", fetchStub);
    await api.complete("t1", { completion_key: "worker:t1", status: "done", result: {}, notify: BOSS });
    await api.update("t1", { status: "blocked", to: BOSS, note: "n" });
    expect([seen[0][0], seen[0][1].method]).toEqual(["https://board.example/api/v1/tasks/t1/complete", "POST"]);
    expect(JSON.parse(seen[0][1].body)).toMatchObject({ completion_key: "worker:t1", notify: BOSS });
    expect([seen[1][0], seen[1][1].method]).toEqual(["https://board.example/api/v1/tasks/t1", "PATCH"]);
    expect(api.handoff).toBeUndefined();
  });

  it("source never contains a backtick or a dollar-brace (served as a String.raw template)", () => {
    expect(WORKER_MJS).not.toContain("`");
    expect(WORKER_MJS).not.toContain("$" + "{");
    expect(WORKER_MJS).toContain("agency-board auto-worker");
  });
});

// ---------------------------------------------------------------- heartbeat throttle (server cap 2/min/token)
describe("worker heartbeat throttle", () => {
  // fake clock + fake api that enforces the server limit: max 2 heartbeats per 60 s window
  function clockApi(tasks: any[], o: { flags?: () => any; dispatchPausedList?: () => boolean } = {}) {
    let t = 1_000_000;
    const hits: number[] = [];
    const f = fakeApi(tasks);
    const base = f.api;
    base.heartbeat = async (b: any) => {
      f.calls.push(["heartbeat", b]);
      const recent = hits.filter((h) => t - h < 60000);
      if (recent.length >= 2) throw new W.ApiErr(429, "RATE_LIMITED", { retry_after: 7 });
      hits.push(t);
      return { ok: true, flags: o.flags ? o.flags() : {} };
    };
    if (o.dispatchPausedList) base.listMine = async () => { f.calls.push(["list"]); return { tasks, dispatch_paused: o.dispatchPausedList!() }; };
    const slept: number[] = [];
    return { ...f, now: () => t, advance: (ms: number) => { t += ms; }, hits, slept, sleep: async (ms: number) => { slept.push(ms); t += ms; } };
  }

  it("(a) full runTask under the 2/60s cap reaches codex and hands back DONE", async () => {
    const c = clockApi([task()]);
    const sp = fakeSpawn("ok");
    const w = W.createWorker({ cfg: cfg({ heartbeat_min_seconds: 30 }), api: c.api, spawn: sp.spawn, home, now: c.now, sleep: c.sleep });
    const r = await w.tick();
    expect(r).toMatchObject({ handed_back: true, status: "DONE" });
    expect(sp.spawned).toHaveLength(1);
    expect(c.hits.length).toBeLessThanOrEqual(2);
    expect(c.slept).toEqual([]);
  });

  it("(b) cached flags still stop: heartbeat paused, then within the throttle no new heartbeat and still stopped", async () => {
    const c = clockApi([task()], { flags: () => ({ dispatchPaused: true }) });
    const w = W.createWorker({ cfg: cfg({ heartbeat_min_seconds: 30 }), api: c.api, spawn: fakeSpawn("ok").spawn, home, now: c.now, sleep: c.sleep });
    expect(await w.tick()).toEqual({ skipped: "dispatch_paused" });
    c.advance(5000);
    expect(await w.tick()).toEqual({ skipped: "dispatch_paused" });
    expect(c.of("heartbeat")).toHaveLength(1);
    expect(c.of("claim")).toHaveLength(0);
  });

  it("(stale) logs the unclaimed-task alert (notify only, once per alert) and never claims a task for someone else", async () => {
    const alert = "unclaimed task for claude@work-pc: Write the weekly report, waiting 44 min";
    const other = task({ handoff_to: "claude@work-pc" });
    const f = fakeApi([other]);
    let polls = 0;
    f.api.listMine = async () => { f.calls.push(["list"]); polls++; return { tasks: [other], dispatch_paused: false, stale_alerts: [alert.replace("44 min", polls === 1 ? "44 min" : "74 min")] }; };
    const logs: string[] = [];
    const w = W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok").spawn, home, log: (l: string) => logs.push(l) });
    expect(await w.tick()).toEqual({ idle: true });
    expect(await w.tick()).toEqual({ idle: true });
    expect(f.calls.filter((c) => c[0] === "claim")).toHaveLength(0);
    expect(f.calls.filter((c) => c[0] === "update" || c[0] === "complete")).toHaveLength(0);
    const hits = logs.filter((l) => /stale/i.test(l));
    expect(hits).toHaveLength(1); // once, even when the same alert comes back (its minutes change, the task does not)
    expect(hits[0]).toContain(alert);
    expect(hits[0]).toMatch(/not claimed/i);
  });

  it("(stale) a hostile alert string is logged on one line, capped", async () => {
    const f = fakeApi([]);
    f.api.listMine = async () => ({ tasks: [], dispatch_paused: false, stale_alerts: ["unclaimed task for codex: A\nFAKE LOG LINE " + "x".repeat(500) + ", waiting 40 min", 42] });
    const logs: string[] = [];
    const w = W.createWorker({ cfg: cfg(), api: f.api, spawn: fakeSpawn("ok").spawn, home, log: (l: string) => logs.push(l) });
    await w.tick();
    const hit = logs.filter((l) => /stale/i.test(l));
    expect(hit).toHaveLength(1);
    expect(hit[0]).not.toContain("\n");
    expect(hit[0].length).toBeLessThan(400);
  });

  it("(b2) writes_frozen cached flag stops; listMine dispatch_paused refreshes the cached flag", async () => {
    const c = clockApi([], { flags: () => ({ writesFrozen: true }) });
    const w = W.createWorker({ cfg: cfg({ heartbeat_min_seconds: 30 }), api: c.api, spawn: fakeSpawn("ok").spawn, home, now: c.now, sleep: c.sleep });
    expect(await w.tick()).toEqual({ skipped: "writes_frozen" });
    let paused = false;
    const c2 = clockApi([], { dispatchPausedList: () => paused });
    const w2 = W.createWorker({ cfg: cfg({ heartbeat_min_seconds: 30 }), api: c2.api, spawn: fakeSpawn("ok").spawn, home, now: c2.now, sleep: c2.sleep });
    expect(await w2.tick()).toEqual({ idle: true });
    paused = true;
    c2.advance(1000);
    expect(await w2.tick()).toEqual({ skipped: "dispatch_paused" }); // heartbeat throttled; listMine says paused
    expect(c2.of("heartbeat")).toHaveLength(1);
    const lists = c2.of("list").length;
    c2.advance(1000);
    expect(await w2.tick()).toEqual({ skipped: "dispatch_paused" }); // now stopped by the refreshed cached flag, before listMine
    expect(c2.of("list")).toHaveLength(lists);
    expect(c2.of("heartbeat")).toHaveLength(1);
  });

  it("(c) RATE_LIMITED with stale cache waits retry_after then retries once; with fresh cache it is not a stop", async () => {
    let t = 1_000_000;
    const slept: number[] = [];
    let n = 0;
    const f = fakeApi([]);
    f.api.heartbeat = async () => { n++; if (n === 1) throw new W.ApiErr(429, "RATE_LIMITED", { retry_after: 7 }); return { ok: true, flags: {} }; };
    const w = W.createWorker({ cfg: cfg(), api: f.api, home, now: () => t, sleep: async (ms: number) => { slept.push(ms); t += ms; } });
    expect(await w.tick()).toEqual({ idle: true });
    expect(slept).toEqual([7000]);
    expect(n).toBe(2);

    // fresh cache (45 s old, past the 30 s throttle, < 60 s) + 429 -> use cache, no wait
    let m = 0;
    const f2 = fakeApi([]);
    f2.api.heartbeat = async () => { m++; if (m === 1) return { ok: true, flags: {} }; throw new W.ApiErr(429, "RATE_LIMITED", { retry_after: 7 }); };
    const sl2: number[] = [];
    let t2 = 5_000_000;
    const w2 = W.createWorker({ cfg: cfg({ heartbeat_min_seconds: 30 }), api: f2.api, home, now: () => t2, sleep: async (ms: number) => { sl2.push(ms); } });
    await w2.tick();
    t2 += 45000;
    expect(await w2.tick()).toEqual({ idle: true });
    expect(sl2).toEqual([]);
    expect(m).toBe(2);

    // stale cache and 429 on both attempts -> stop (as before), retry_after capped at 60 s
    const f3 = fakeApi([]);
    f3.api.heartbeat = async () => { throw new W.ApiErr(429, "RATE_LIMITED", { retry_after: 500 }); };
    const sl3: number[] = [];
    const w3 = W.createWorker({ cfg: cfg(), api: f3.api, home, now: () => 1, sleep: async (ms: number) => { sl3.push(ms); } });
    expect(await w3.tick()).toEqual({ skipped: "heartbeat_failed:RATE_LIMITED" });
    expect(sl3).toEqual([60000]);
  });

  it("(d) lease renewal: task_id heartbeats keep flowing at ~heartbeat_seconds during a long run", async () => {
    // fake clock runs 1000x real time: 1 real ms = 1 fake s
    const now = () => Date.now() * 1000;
    const f = fakeApi([task()]);
    const stamps: number[] = [];
    const orig = f.api.heartbeat;
    f.api.heartbeat = async (b: any) => { if (b.task_id && b.status_note === "codex running") stamps.push(now()); return orig(b); };
    const sp = fakeSpawn("hang");
    // heartbeat_seconds 0.06 = a 60 fake-s tick every 60 real ms; run ~300 real ms (timeout_minutes 0.005)
    const c2 = cfg({ heartbeat_seconds: 0.06, heartbeat_min_seconds: 30, timeout_minutes: 0.005 });
    const w = W.createWorker({ cfg: c2, api: f.api, spawn: sp.spawn, home, now });
    await w.tick();
    expect(stamps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < stamps.length; i++) expect(stamps[i] - stamps[i - 1]).toBeLessThan(150000); // << the 600 s lease
  });
});

describe("worker main guard", () => {
  it("isMain resolves symlinks and falls back to the plain path", () => {
    const real = join(root, "realdir");
    mkdirSync(real, { recursive: true });
    const file = join(real, "w.mjs");
    writeFileSync(file, "export {};");
    const link = join(root, "linkdir");
    symlinkSync(real, link);
    const url = pathToFileURL(file).href;
    expect(W.isMain(file, url)).toBe(true);
    expect(W.isMain(join(link, "w.mjs"), url)).toBe(true);
    expect(W.isMain(join(root, "nope", "w.mjs"), url)).toBe(false);
    expect(W.isMain(join(root, "nope", "w.mjs"), pathToFileURL(join(root, "nope", "w.mjs")).href)).toBe(true);
    expect(W.isMain(undefined, url)).toBe(false);
  });

  it("running the script through a symlinked directory still executes main()", () => {
    const real = join(root, "realrun");
    const h = join(root, "runhome");
    mkdirSync(real, { recursive: true });
    mkdirSync(join(h, ".agency-board"), { recursive: true });
    writeFileSync(join(real, "worker.mjs"), WORKER_MJS);
    symlinkSync(real, join(root, "linkrun"));
    const r = spawnSync(process.execPath, [join(root, "linkrun", "worker.mjs"), "--once"], { env: { ...process.env, HOME: h }, encoding: "utf8" });
    expect(r.status).toBe(78); // main ran: no worker.json -> config error exit 78 (before the fix: silent exit 0)
  });
});

// ---- worker mode b (2026-10-13): launchd StartInterval wake, linger after a task, exit 0 when idle ----
describe("worker mode b: runUntilIdle (linger window)", () => {
  /** Fake clock: sleep() advances now(). script(t) answers each tick by elapsed seconds. */
  function sim(script: (t: number, n: number) => unknown, windowS = 1800, intervalS = 300) {
    let t = 0;
    const ticks: number[] = [];
    const sleeps: number[] = [];
    const logs: string[] = [];
    const p = W.runUntilIdle({
      tick: async () => { ticks.push(t); const r = script(t, ticks.length); if (r instanceof Error) throw r; return r; },
      now: () => t * 1000,
      sleep: async (ms: number) => { sleeps.push(ms / 1000); t += ms / 1000; },
      windowMs: windowS * 1000, intervalMs: intervalS * 1000, log: (l: string) => logs.push(l),
    });
    return p.then((res: any) => ({ res, ticks, sleeps, logs, end: t }));
  }
  const worked = { claimed: true };

  it("first wake finds nothing: exits at once (no sleep), near-zero idle cost", async () => {
    const o = await sim(() => ({ idle: true }));
    expect(o.res.reason).toBe("idle");
    expect(o.ticks).toEqual([0]);
    expect(o.sleeps).toEqual([]);
  });
  it("first wake skipped (kill switch / dispatch_paused) or erroring: also exits at once", async () => {
    expect((await sim(() => ({ skipped: "dispatch_paused" }))).ticks).toEqual([0]);
    const e = await sim(() => new Error("boom"));
    expect(e.ticks).toEqual([0]);
    expect(e.logs.join("\n")).toMatch(/tick error/);
  });
  it("a worked task opens a 30-min window polled every 300 s; idle until the window is over, then exit", async () => {
    const o = await sim((t) => (t === 0 ? worked : { idle: true }));
    expect(o.res.reason).toBe("window_over");
    expect(o.ticks).toEqual([0, 300, 600, 900, 1200, 1500, 1800]);
    expect(o.end).toBe(1800);
  });
  it("each new task restarts the window (task at 600 s -> exit at 2400 s)", async () => {
    const o = await sim((t) => (t === 0 || t === 600 ? worked : { idle: true }));
    expect(o.res.reason).toBe("window_over");
    expect(o.end).toBe(2400);
    expect(o.logs.filter((l: string) => /window/.test(l)).length).toBeGreaterThanOrEqual(2);
  });
  it("the last nap is clamped to the time left; a tick error inside the window does not end it", async () => {
    const o = await sim((t) => (t === 0 ? worked : t === 300 ? new Error("net") : { idle: true }), 1000, 300);
    expect(o.sleeps).toEqual([300, 300, 300, 100]);
    expect(o.end).toBe(1000);
  });
  it("busy/skipped results inside the window are not 'work' (they do not extend it)", async () => {
    const o = await sim((t) => (t === 0 ? worked : t === 300 ? { skipped: "dispatch_paused" } : { busy: true }), 900, 300);
    expect(o.end).toBe(900);
  });
  it("window and interval come from AGENCY_BOARD_LINGER_WINDOW / AGENCY_BOARD_LINGER_INTERVAL (same names as linger.sh); junk -> 1800 / 300", () => {
    const c = (env: Record<string, string>) => W.loadConfig({ base_url: "https://x.example", identity: ME }, env, home);
    expect(c({}).linger_window_seconds).toBe(1800);
    expect(c({}).linger_interval_seconds).toBe(300);
    expect(c({ AGENCY_BOARD_LINGER_WINDOW: "20", AGENCY_BOARD_LINGER_INTERVAL: "2" })).toMatchObject({ linger_window_seconds: 20, linger_interval_seconds: 2 });
    expect(c({ AGENCY_BOARD_LINGER_WINDOW: "abc", AGENCY_BOARD_LINGER_INTERVAL: "0" })).toMatchObject({ linger_window_seconds: 1800, linger_interval_seconds: 300 });
  });
  it("source: no KeepAlive throttle sleep left in the served worker; main() uses the linger loop", () => {
    expect(WORKER_MJS).not.toContain("600000");
    expect(WORKER_MJS).not.toMatch(/KeepAlive/);
    expect(WORKER_MJS).toContain("runUntilIdle(");
  });
  it("end to end: --once style script run with no config exits 78 at once (no 10-minute sleep)", () => {
    const h = join(root, "nocfg-home");
    mkdirSync(join(h, ".agency-board"), { recursive: true });
    const f = join(root, "nocfg-worker.mjs");
    writeFileSync(f, WORKER_MJS);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [f], { env: { ...process.env, HOME: h }, encoding: "utf8", timeout: 20000 });
    expect(r.status).toBe(78);
    expect(Date.now() - t0).toBeLessThan(15000);
  });
});
