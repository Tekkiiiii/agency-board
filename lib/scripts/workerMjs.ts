// worker.mjs, the codex auto-worker (CONTRACT §19), served by app/worker.mjs/route.ts and
// installed by `connect.sh --worker` to ~/.agency-board/worker.mjs (run by a launchd LaunchAgent).
// String.raw keeps every backslash verbatim. The source must never contain a backtick or a
// dollar-brace sequence (JS would interpolate it); it uses string concatenation only.
// Node >= 20, ESM, no dependencies. Tests write this string to a temp .mjs and import it.
export const WORKER_MJS = String.raw`#!/usr/bin/env node
// agency-board auto-worker (installed by connect.sh --worker). See docs/connect.md "Auto-worker".
// Polls the task board as codex@<machine>, claims ONLY tasks explicitly handed to "codex" or to this
// identity by the director (server-resolved role, on by default) or an allowlisted assigner, runs "codex exec" in
// the folder mapped from the task namespace (or a per-namespace default workdir), and closes the task with ONE
// atomic complete(notify: assigner). Never logs tokens or task content to worker.log.
import { spawn as nodeSpawn, execFile as nodeExecFile } from "node:child_process";
import { readFileSync, existsSync, statSync, realpathSync, mkdirSync, appendFileSync, openSync, closeSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, isAbsolute, sep, delimiter } from "node:path";
import { pathToFileURL } from "node:url";

export const VERSION = "1";
export const CODEX_FALLBACK_BIN = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
// Every git command the worker runs carries these: no hooks, no fsmonitor command, no ext:: transport.
export const GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
export const PUSH_RE = /^git push(?: [A-Za-z0-9._\/-]+){0,2}$/;
const IDENT_RE = /^codex@[A-Za-z0-9._-]{1,64}$/;
const ID_RE = /^[0-9a-f-]{36}$/i;
const OUTWARD_RE = /^\s*OUTWARD:\s*(.+?)\s*$/;

export class ApiErr extends Error {
  constructor(status, code, details) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details || null;
  }
}

const short = (s, n) => {
  const t = String(s == null ? "" : s);
  return t.length > n ? t.slice(0, n - 3) + "..." : t;
};
const codeOf = (err) => (err && err.code) || "error";

// ------------------------------------------------------------------ config
export function loadConfig(raw, env, home) {
  const e = env || {};
  const c = raw || {};
  const base = String(e.AGENCY_BOARD_BASE || c.base_url || "").replace(/\/+$/, "");
  if (!/^https?:\/\/[A-Za-z0-9:\/._-]+$/.test(base)) throw new Error("config: base_url must be an http(s) URL");
  const identity = String(c.identity || "");
  if (!IDENT_RE.test(identity) || identity.indexOf("CHANGE-ME") >= 0) throw new Error("config: identity must be codex@<machine> (edit worker.json)");
  const allow = Array.isArray(c.allow_assigned_by) ? c.allow_assigned_by.filter((x) => typeof x === "string" && x.indexOf("@") > 0) : [];
  const folders = c.folders && typeof c.folders === "object" && !Array.isArray(c.folders) ? c.folders : {};
  const num = (v, d) => (typeof v === "number" && v > 0 ? v : d);
  // Default workdirs: <root>/<sanitized-namespace>, each its own git repo. The root must be an absolute path.
  const wroot = c.default_workdir_root === undefined ? join(home, ".agency-board", "workdirs") : c.default_workdir_root;
  if (typeof wroot !== "string" || !isAbsolute(wroot)) throw new Error("config: default_workdir_root must be an absolute path");
  const ap = e.AUTO_PUSH !== undefined && e.AUTO_PUSH !== "" ? e.AUTO_PUSH === "1" || e.AUTO_PUSH === "true" : c.auto_push === true;
  return {
    base_url: base,
    identity,
    token_file: typeof c.token_file === "string" ? c.token_file : join(home, ".agency-board", "codex.token"),
    allow_assigned_by: allow,
    // Tasks whose assigner is currently the director (assigned_by_role, resolved by the server at read time) are
    // accepted without an allowlist entry. Only an explicit false turns this off.
    accept_director: c.accept_director !== false,
    folders,
    // Namespaces with no folder mapping get <default_workdir_root>/<namespace> (own repo). Only an explicit false turns this off.
    default_workdirs: c.default_workdirs !== false,
    default_workdir_root: wroot,
    codex_bin: typeof c.codex_bin === "string" ? c.codex_bin : "",
    model: typeof c.model === "string" ? c.model : "",
    auto_push: ap,
    // poll_seconds is now ONLY the approval-wait poll step. How long the worker lingers after a task and how often
    // it checks the inbox in that window come from env, the same names linger.sh uses (mode b, 2026-10-13).
    poll_seconds: num(c.poll_seconds, 60),
    linger_window_seconds: num(Number(e.AGENCY_BOARD_LINGER_WINDOW), 1800),
    linger_interval_seconds: num(Number(e.AGENCY_BOARD_LINGER_INTERVAL), 300),
    heartbeat_seconds: num(c.heartbeat_seconds, 60),
    // Min gap between real POST /heartbeat calls: server cap is 2 per 60 s per token, so 30 s fits. Clamped < 60 s.
    heartbeat_min_seconds: Math.min(num(c.heartbeat_min_seconds, 30), 59),
    timeout_minutes: num(c.timeout_minutes, 30),
    approval_wait_minutes: num(c.approval_wait_minutes, 30),
    runs_dir: typeof c.runs_dir === "string" ? c.runs_dir : join(home, ".agency-board", "worker-runs"),
  };
}

// ------------------------------------------------------------------ pure rules
// Claim rule: open AND handoff_to is exactly "codex" or this identity. Unassigned (null) never matches.
export function isForMe(task, identity) {
  return !!task && task.status === "open" && (task.handoff_to === "codex" || task.handoff_to === identity);
}

// Allowed assigner: the director (assigned_by_role from the server, unless accept_director is false) OR an
// identity listed in allow_assigned_by (extra assigners, e.g. a lead). Missing / unknown role never matches.
export function isAllowed(task, cfg) {
  if (!task || typeof task.assigned_by !== "string") return false;
  if (cfg.accept_director && task.assigned_by_role === "director") return true;
  return cfg.allow_assigned_by.indexOf(task.assigned_by) >= 0;
}

// Never touch the Claude config tree (~/.claude): memory, agents, settings and hooks live there.
export function underClaude(real, home) {
  let c = join(home, ".claude");
  try { c = realpathSync(c); } catch (err) { try { c = join(realpathSync(home), ".claude"); } catch (err2) { /* keep */ } }
  return real === c || real.indexOf(c + sep) === 0;
}

// Namespace -> one safe directory name: [a-z0-9._-], "/" -> "__". Returns null for empty, ".." or hidden names.
export function safeNsDir(ns) {
  const s = String(ns == null ? "" : ns).toLowerCase();
  if (!s || s.length > 200 || s.indexOf("..") >= 0 || s.split("/").indexOf("") >= 0) return null; // empty or empty-segment names
  const d = s.split("/").join("__").replace(/[^a-z0-9._-]/g, "_");
  if (!d || d.indexOf("..") >= 0 || d.charAt(0) === ".") return null;
  return d;
}

// Pattern: exact namespace, or "a/*" = a and everything under a/. "*" alone is refused (too broad).
function nsPatternMatch(ns, p) {
  if (typeof p !== "string" || p === "*" || p === "") return false;
  if (p.slice(-2) === "/*") {
    const root = p.slice(0, -2);
    return ns === root || ns.indexOf(root + "/") === 0;
  }
  return ns === p;
}

export function mapFolder(ns, folders, home) {
  let best = null;
  for (const p of Object.keys(folders || {})) {
    if (nsPatternMatch(ns, p) && (best === null || p.length > best.length)) best = p;
  }
  if (best === null) return { ok: false, unmapped: true, reason: "namespace " + ns + " is not mapped to a folder in worker.json on the worker machine" };
  const dir = folders[best];
  if (typeof dir !== "string" || !isAbsolute(dir)) return { ok: false, reason: "folder for " + best + " is not an absolute path" };
  let real;
  try {
    if (!statSync(dir).isDirectory()) return { ok: false, reason: "folder for " + best + " is not a directory" };
    real = realpathSync(dir);
  } catch (err) {
    return { ok: false, reason: "folder for " + best + " does not exist" };
  }
  let realHome = home;
  try { realHome = realpathSync(home); } catch (err) { /* keep */ }
  // never $HOME itself, never "/" and never any ancestor of $HOME
  if (real === realHome || real === sep || realHome.indexOf(real + sep) === 0) {
    return { ok: false, reason: "folder for " + best + " is the home directory or one of its parents (refused)" };
  }
  if (underClaude(real, home)) return { ok: false, reason: "folder for " + best + " is inside ~/.claude (refused)" };
  return { ok: true, folder: real, pattern: best };
}

export function parseOutward(text) {
  const out = [];
  for (const l of String(text || "").split(/\r?\n/)) {
    const m = l.match(OUTWARD_RE);
    if (m && out.length < 5) out.push(short(m[1], 300));
  }
  return out;
}

export function buildPrompt(task, identity) {
  return [
    "You are " + identity + ", an unattended worker. Task from " + task.assigned_by + " (task id " + task.id + ", namespace " + task.namespace + ").",
    "Rules: you run inside a sandbox in the current folder only. You may read and edit files here.",
    "You CANNOT run git commit (the .git folder is read-only for you). Leave your changes in the working tree; the worker commits them after you finish.",
    "Do NOT git push, deploy, publish, send email or messages, or call any external API that writes. You have no network.",
    "If the task needs any such outward action, do not attempt it: describe it on its own line at the end of your final message as",
    "OUTWARD: <one-line action>   (for a push use exactly: OUTWARD: git push <remote> <branch>). A human approves it later.",
    "Do not include secrets, credentials, customer or employee personal data, or non-public financials in your final message.",
    "End with a short summary of what you did (files changed, anything left undone).",
    "",
    "Task title: " + task.title,
    "",
    task.body ? String(task.body) : "(no body)",
  ].join("\n");
}

export function codexArgs(cfg, folder, lastMsgFile) {
  // Verified against "codex exec --help" (codex-cli 0.160.1). Prompt comes from stdin ("-").
  const a = [
    "exec",
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=false",
    "--ignore-user-config", // no MCP servers (agency-board token), no notify hooks, no user profiles
    "--skip-git-repo-check",
    "--color", "never",
    "-C", folder,
    "-o", lastMsgFile,
  ];
  if (cfg.model) a.push("-m", cfg.model);
  a.push("-");
  return a;
}

// Allowlist, so AGENCY_BOARD_TOKEN_* and every other secret in the worker env never reach codex.
const ENV_KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM", "CODEX_HOME"];
export function childEnv(env) {
  const out = {};
  for (const k of Object.keys(env || {})) {
    if (ENV_KEEP.indexOf(k) >= 0 || k.indexOf("LC_") === 0) out[k] = env[k];
  }
  return out;
}

export function resolveCodexBin(cfg, env) {
  if (cfg.codex_bin) return cfg.codex_bin;
  for (const d of String((env && env.PATH) || "").split(delimiter)) {
    if (d && existsSync(join(d, "codex"))) return join(d, "codex");
  }
  return existsSync(CODEX_FALLBACK_BIN) ? CODEX_FALLBACK_BIN : "";
}

export function stopReason(flags) {
  const f = flags || {};
  if (f.dispatchPaused || f.dispatch_paused) return "dispatch_paused";
  if (f.writesFrozen || f.writes_frozen) return "writes_frozen";
  return null;
}

// ------------------------------------------------------------------ REST client
export function makeApi(base, token, fetchImpl) {
  const f = fetchImpl || fetch;
  async function req(method, path, body) {
    let res;
    try {
      res = await f(base + "/api/v1" + path, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new ApiErr(0, "NETWORK");
    }
    let j = null;
    try { j = await res.json(); } catch (err) { j = null; }
    if (!res.ok) throw new ApiErr(res.status, (j && j.error && j.error.code) || "HTTP_" + res.status, j && j.error && j.error.details);
    return j ? j.data : undefined;
  }
  const id = (x) => encodeURIComponent(String(x));
  return {
    // stale=peek: the unclaimed-task alert is returned but NOT recorded as shown, so the human-facing hooks (linger, SessionStart) still get it.
    listMine: () => req("GET", "/tasks?mine=1&status=open&stale=peek"),
    claim: (t) => req("POST", "/tasks/" + id(t) + "/claim", {}),
    heartbeat: (body) => req("POST", "/heartbeat", body),
    update: (t, body) => req("PATCH", "/tasks/" + id(t), body),
    complete: (t, body) => req("POST", "/tasks/" + id(t) + "/complete", body),
    requestApproval: (body) => req("POST", "/approvals", body),
    getApproval: (a) => req("GET", "/approvals/" + id(a)),
  };
}

// ------------------------------------------------------------------ process runner
function defaultKill(child, sig) {
  try {
    if (child.pid) process.kill(-child.pid, sig); // whole process group (spawned detached)
    else child.kill(sig);
  } catch (err) {
    try { child.kill(sig); } catch (err2) { /* gone */ }
  }
}

// Runs one child; resolves { reason: exit|timeout|<stop reason>|spawn_error, code, signal }.
// onTick() runs every tickMs and may return a stop reason string to kill the child.
export function runProcess(o) {
  const spawnImpl = o.spawn || nodeSpawn;
  const kill = o.kill || defaultKill;
  return new Promise((resolve) => {
    let done = false;
    let reason = null;
    let child;
    const timers = [];
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      resolve(r);
    };
    const stop = (why) => {
      if (reason) return;
      reason = why;
      kill(child, "SIGTERM");
      const k = setTimeout(() => kill(child, "SIGKILL"), o.killGraceMs || 10000);
      if (k.unref) k.unref();
    };
    const io = o.outFd == null ? "ignore" : o.outFd;
    try {
      child = spawnImpl(o.bin, o.args, { cwd: o.cwd, env: o.env, detached: true, stdio: ["pipe", io, io] });
    } catch (err) {
      finish({ reason: "spawn_error", code: null, signal: null });
      return;
    }
    child.on("error", () => finish({ reason: reason || "spawn_error", code: null, signal: null }));
    child.on("exit", (code, signal) => finish({ reason: reason || "exit", code, signal }));
    if (child.stdin) {
      if (child.stdin.on) child.stdin.on("error", () => {});
      child.stdin.end(o.input || "");
    }
    timers.push(setTimeout(() => stop("timeout"), o.timeoutMs));
    if (o.onTick) {
      let ticking = false;
      timers.push(setInterval(async () => {
        if (ticking || reason) return;
        ticking = true;
        try {
          const why = await o.onTick();
          if (why) stop(why);
        } finally {
          ticking = false;
        }
      }, o.tickMs));
    }
  });
}

// ------------------------------------------------------------------ worker
export function createWorker(deps) {
  const cfg = deps.cfg;
  const api = deps.api;
  const log = deps.log || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const env = deps.env || process.env;
  const home = deps.home || homedir();
  const runGit = deps.execFile || ((bin, args, opts) => new Promise((res) => {
    nodeExecFile(bin, args, Object.assign({ maxBuffer: 4 * 1024 * 1024 }, opts), (err, stdout) => res({ ok: !err, code: err ? err.code : 0, stdout: String(stdout || "") }));
  }));
  const now = deps.now || (() => Date.now());
  const resolveBin = deps.resolveBin || resolveCodexBin; // test seam; production default unchanged
  const seen = new Set();
  let busy = false;
  // Heartbeat throttle: the server allows 2 heartbeats / 60 s / token, so killSwitch() sends at most one per
  // heartbeat_min_seconds and otherwise answers from the flags of the last successful heartbeat.
  let hbFlags = null; // flags from the last successful heartbeat (+ dispatch_paused refreshed by listMine)
  let hbAt = -Infinity; // when hbFlags was last refreshed by a real heartbeat
  const hbMinMs = cfg.heartbeat_min_seconds * 1000;

  const once = (key, line) => {
    if (seen.has(key)) return;
    seen.add(key);
    log(line);
  };

  // Kill switch: the heartbeat response carries the server flags. Any error = do not proceed.
  async function killSwitch(note, taskId) {
    if (hbFlags && now() - hbAt < hbMinMs) return stopReason(hbFlags); // throttled: cached flags
    const body = { status_note: note };
    if (taskId) body.task_id = taskId; // a real send with task_id renews the 600 s lease (hbMinMs <= 59 s, tick every heartbeat_seconds)
    for (let attempt = 0; ; attempt++) {
      try {
        const hb = await api.heartbeat(body);
        hbFlags = Object.assign({}, (hb && hb.flags) || {});
        hbAt = now();
        return stopReason(hbFlags);
      } catch (err) {
        if (err && err.code === "LEASE_LOST") return "lease_lost";
        if (err && err.code === "RATE_LIMITED") {
          if (hbFlags && now() - hbAt < 60000) return stopReason(hbFlags); // cache fresh enough: not a stop
          if (attempt === 0) {
            const ra = err.details && Number(err.details.retry_after);
            await sleep(Math.min(ra > 0 ? ra : 60, 60) * 1000);
            continue;
          }
        }
        return "heartbeat_failed:" + codeOf(err);
      }
    }
  }

  async function release(t, why) {
    try { await api.update(t.id, { status: "open", note: "released by " + cfg.identity + ": " + why }); }
    catch (err) { log("task " + t.id + " release failed " + codeOf(err) + " (lease expires on its own)"); }
  }

  // Close the task with ONE atomic complete(notify: assigner). The completion_key makes a retry idempotent.
  // Guard 422 -> metadata-only complete (content never stripped and resent) -> last resort PATCH failed.
  async function finish(t, status, note, result) {
    const body = (st, n, res) => ({ completion_key: "worker:" + t.id, status: st, result: res, note: short(n, 2000), notify: t.assigned_by });
    try {
      await api.complete(t.id, body(status === "DONE" ? "done" : "failed", status + ": " + note, result));
      log("task " + t.id + " " + status + " completed, notified " + t.assigned_by);
      return { handed_back: true, status };
    } catch (err) {
      if (err && err.status === 422) {
        const meta = "result rejected by the write guard (" + err.code + "); content withheld";
        log("task " + t.id + " guard rejected result code=" + err.code + "; sending metadata-only completion");
        try {
          await api.complete(t.id, body("failed", meta, { withheld: true, code: err.code }));
        } catch (err2) {
          try { await api.update(t.id, { status: "failed", note: meta }); } catch (err3) { log("task " + t.id + " metadata report failed " + codeOf(err3)); }
        }
        return { handed_back: false, status: "guard_rejected", code: err.code };
      }
      log("task " + t.id + " complete failed " + codeOf(err));
      return { handed_back: false, status: "error", code: codeOf(err) };
    }
  }

  // Cannot proceed (unmapped folder, codex missing): route the task back to the assigner as blocked.
  async function block(t, reason) {
    try {
      await api.update(t.id, { status: "blocked", to: t.assigned_by, note: short(reason, 2000) });
      log("task " + t.id + " BLOCKED routed to " + t.assigned_by);
      return { handed_back: true, status: "BLOCKED" };
    } catch (err) {
      log("task " + t.id + " block failed " + codeOf(err));
      return { handed_back: false, status: "error", code: codeOf(err) };
    }
  }

  // All worker git calls go through here: hooks / fsmonitor / ext transport disabled, secrets stripped.
  const git = async (folder, args) => {
    const r = await runGit("git", GIT_SAFE.concat(args), { cwd: folder, env: childEnv(env), timeout: 120000 });
    return { ok: !!(r && r.ok), stdout: String((r && r.stdout) || "").trim() };
  };
  const redactUrl = (u) => String(u).replace(/\/\/[^\/@\s]*@/, "//");

  // codex cannot write .git (sandbox), so the worker commits what codex left in the working tree.
  async function commitWork(t, folder) {
    const inside = await git(folder, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout !== "true") return { skipped: "not a git work tree" };
    const st = await git(folder, ["status", "--porcelain"]);
    if (!st.ok) return { failed: "git status failed" };
    if (!st.stdout) return { skipped: "working tree clean (nothing to commit)" };
    const files = st.stdout.split(/\r?\n/).filter(Boolean).length;
    const title = String(t.title || "task").replace(/\s+/g, " ").trim().slice(0, 72);
    const who = ["-c", "user.name=" + cfg.identity, "-c", "user.email=" + cfg.identity, "-c", "commit.gpgsign=false"];
    const add = await git(folder, ["add", "-A", "--", "."]); // scoped to the folder, never the whole enclosing repo
    if (!add.ok) return { failed: "git add failed" };
    const cm = await git(folder, who.concat(["commit", "-m", title + " (agency-board task " + t.id + ")"]));
    if (!cm.ok) return { failed: "git commit failed" };
    const head = await git(folder, ["rev-parse", "HEAD"]);
    return { sha: head.ok ? head.stdout : null, files_changed: files };
  }

  async function approvalsFor(t, actions, folder, notes) {
    const out = [];
    for (const action of actions) {
      let where = "";
      if (PUSH_RE.test(action)) {
        const parts = action.split(" ").slice(2);
        const remote = parts[0] || "origin";
        const url = await git(folder, ["remote", "get-url", remote]);
        if (!url.ok || !url.stdout) { notes.push("push skipped, no approval filed: cannot read URL of remote " + remote); continue; }
        const range = parts[1] ? remote + "/" + parts[1] + "..HEAD" : "@{u}..HEAD";
        const ahead = await git(folder, ["rev-list", "--count", range]);
        if (ahead.ok && Number(ahead.stdout) === 0) { notes.push("push skipped, no approval filed: nothing ahead of " + (parts[1] ? remote + "/" + parts[1] : "upstream")); continue; }
        if (!ahead.ok) {
          const head = await git(folder, ["rev-parse", "--verify", "HEAD"]);
          if (!head.ok) { notes.push("push skipped, no approval filed: no commit to push"); continue; }
        }
        where = " [remote " + remote + " = " + redactUrl(url.stdout) + "]";
      }
      let a;
      try {
        a = await api.requestApproval({ question: cfg.identity + " requests an outward action for task " + t.id + ": " + action + where, options: ["approved", "denied"], task_id: t.id });
      } catch (err) {
        out.push({ action, approval_id: null, status: "request_failed:" + codeOf(err), executed: false });
        continue;
      }
      const rec = { action, approval_id: a && a.id, status: "pending", executed: false };
      out.push(rec);
      log("task " + t.id + " outward action -> approval " + rec.approval_id);
      if (!(cfg.auto_push && PUSH_RE.test(action))) continue; // never executed by the worker
      const deadline = Date.now() + cfg.approval_wait_minutes * 60000;
      while (Date.now() < deadline) {
        let g = null;
        try { g = await api.getApproval(rec.approval_id); } catch (err) { g = null; }
        if (g && g.status && g.status !== "pending") { rec.status = g.status; break; }
        const why = await killSwitch("waiting for approval", t.id);
        if (why) { rec.status = "aborted:" + why; break; }
        await sleep(cfg.poll_seconds * 1000);
      }
      if (rec.status === "approved") {
        const r = await git(folder, action.split(" ").slice(1));
        rec.executed = !!r.ok;
        log("task " + t.id + " approved push " + (r.ok ? "done" : "failed"));
      }
    }
    return out;
  }

  // Folder must be a git repo ROOT with a clean working tree before codex runs: the worker commits afterwards, so a
  // subdirectory of a bigger repo (or a dirty tree) would sweep unrelated work into the commit.
  async function checkRepo(folder) {
    const top = await git(folder, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || !top.stdout) return { ok: false, reason: "folder is not a git repository (git init it, or map a repo root)" };
    let realTop = top.stdout;
    try { realTop = realpathSync(top.stdout); } catch (err) { /* keep */ }
    if (realTop !== folder) return { ok: false, reason: "folder is inside the git repository " + realTop + " but is not its root (map the repo root or a dedicated clone)" };
    const st = await git(folder, ["status", "--porcelain"]);
    if (!st.ok) return { ok: false, reason: "git status failed in the folder" };
    if (st.stdout) return { ok: false, reason: "working tree has uncommitted changes (commit or stash them, then re-assign)" };
    return { ok: true };
  }

  // Default workdir for an unmapped namespace: <default_workdir_root>/<sanitized-ns>, created on demand as its own repo root.
  async function defaultWorkdir(ns) {
    const name = safeNsDir(ns);
    if (!name) return { ok: false, reason: "namespace " + ns + " cannot be turned into a safe default folder name" };
    if (underClaude(cfg.default_workdir_root, home)) return { ok: false, reason: "default_workdir_root is inside ~/.claude (refused)" }; // before anything is created
    let realRoot;
    try {
      mkdirSync(cfg.default_workdir_root, { recursive: true, mode: 0o700 });
      realRoot = realpathSync(cfg.default_workdir_root);
    } catch (err) { return { ok: false, reason: "default_workdir_root cannot be created" }; }
    let realHome = home;
    try { realHome = realpathSync(home); } catch (err) { /* keep */ }
    if (realRoot === realHome || realRoot === sep || realHome.indexOf(realRoot + sep) === 0) return { ok: false, reason: "default_workdir_root is the home directory or one of its parents (refused)" };
    if (underClaude(realRoot, home)) return { ok: false, reason: "default_workdir_root is inside ~/.claude (refused)" };
    const inside = await git(realRoot, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.ok && inside.stdout === "true") return { ok: false, reason: "default_workdir_root is inside a git work tree (refused; pick a folder outside any repo)" };
    const dir = join(realRoot, name);
    let real;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      real = realpathSync(dir);
    } catch (err) { return { ok: false, reason: "default workdir cannot be created" }; }
    if (real !== dir) return { ok: false, reason: "default workdir resolves outside default_workdir_root (refused)" };
    const top = await git(real, ["rev-parse", "--show-toplevel"]);
    if (!top.ok) {
      const ini = await git(real, ["-c", "init.defaultBranch=main", "init", "-q"]);
      if (!ini.ok) return { ok: false, reason: "git init failed in the default workdir" };
      const who = ["-c", "user.name=" + cfg.identity, "-c", "user.email=" + cfg.identity, "-c", "commit.gpgsign=false"];
      const c0 = await git(real, who.concat(["commit", "--allow-empty", "-q", "-m", "agency-board worker: initial commit"]));
      if (!c0.ok) return { ok: false, reason: "initial commit failed in the default workdir" };
    }
    return { ok: true, folder: real };
  }

  // Everything that can be checked before claiming: where codex runs, and whether that folder is safe to commit in.
  // (Telling the assigner still needs a claim: the server only lets the claimer block a task back.)
  async function resolveWorkdir(t) {
    const m = mapFolder(t.namespace, cfg.folders, home);
    let folder;
    let source;
    if (m.ok) { folder = m.folder; source = "mapped"; }
    else if (m.unmapped && cfg.default_workdirs) {
      const d = await defaultWorkdir(t.namespace);
      if (!d.ok) return d;
      folder = d.folder; source = "default";
    } else {
      return { ok: false, reason: m.reason + ". Map it in ~/.agency-board/worker.json (folders) and re-assign." };
    }
    const chk = await checkRepo(folder);
    if (!chk.ok) return { ok: false, reason: chk.reason + " [" + source + " workdir for " + t.namespace + "]" };
    return { ok: true, folder, source };
  }

  async function runTask(t) {
    const why0 = await killSwitch("worker claiming");
    if (why0) { log("kill switch before claim: " + why0); return { skipped: why0 }; }
    const map = await resolveWorkdir(t);
    try {
      await api.claim(t.id);
    } catch (err) {
      log("task " + t.id + " claim failed " + codeOf(err));
      return { skipped: "claim_" + codeOf(err) };
    }
    log("task " + t.id + " claimed ns=" + t.namespace + (map.ok ? " workdir=" + map.source : " workdir refused"));
    if (!map.ok) return block(t, map.reason);
    const bin = resolveBin(cfg, env);
    if (!bin) return block(t, "codex CLI not found on the worker machine");

    const why1 = await killSwitch("codex starting", t.id);
    if (why1) { if (why1 !== "lease_lost") await release(t, why1); return { stopped: why1 }; }

    mkdirSync(cfg.runs_dir, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(tmpdir(), "hub-worker-"));
    const lastMsg = join(tmp, "last-message.txt");
    const fd = openSync(join(cfg.runs_dir, t.id + ".log"), "a", 0o600);
    const started = Date.now();
    let r;
    try {
      r = await runProcess({
        spawn: deps.spawn, kill: deps.kill, bin, args: codexArgs(cfg, map.folder, lastMsg), cwd: map.folder, env: childEnv(env),
        input: buildPrompt(t, cfg.identity), outFd: fd, timeoutMs: cfg.timeout_minutes * 60000, killGraceMs: deps.killGraceMs,
        tickMs: cfg.heartbeat_seconds * 1000, onTick: () => killSwitch("codex running", t.id),
      });
    } finally {
      closeSync(fd);
    }
    const duration_s = Math.round((Date.now() - started) / 1000);
    let text = "";
    try { text = readFileSync(lastMsg, "utf8"); } catch (err) { text = ""; }
    rmSync(tmp, { recursive: true, force: true });
    log("task " + t.id + " codex ended reason=" + r.reason + " code=" + r.code + " duration_s=" + duration_s);

    if (r.reason === "timeout") {
      const note = "FAILED: codex exceeded the " + cfg.timeout_minutes + " min timeout and was killed";
      try { await api.complete(t.id, { completion_key: "worker:" + t.id, status: "failed", result: { timeout: true, duration_s, worker: cfg.identity }, note, notify: t.assigned_by }); }
      catch (err) { log("task " + t.id + " mark failed error " + codeOf(err)); }
      return { status: "timeout" };
    }
    if (r.reason === "lease_lost") return { stopped: "lease_lost" };
    if (r.reason !== "exit" && r.reason !== "spawn_error") { await release(t, r.reason); return { stopped: r.reason }; }

    const why2 = await killSwitch("codex finished", t.id);
    if (why2) { if (why2 !== "lease_lost") await release(t, why2); return { stopped: why2 }; }

    const summary = text.trim() || (r.reason === "spawn_error" ? "codex could not be started" : "(codex wrote no final message)");
    const ok = r.reason === "exit" && r.code === 0;
    let commit;
    if (ok) {
      commit = await commitWork(t, map.folder);
      if (commit.failed) {
        const res = { summary: short(summary, 4000), exit_code: r.code, duration_s, approvals: [], commit: { failed: commit.failed }, auto_push: cfg.auto_push, worker: cfg.identity };
        const fb = await finish(t, "FAILED", commit.failed + " after codex finished; no approvals filed. " + summary, res);
        return Object.assign({}, fb, { approvals: [] });
      }
    } else {
      commit = { skipped: "codex did not exit 0" };
    }
    const notes = [];
    const approvals = await approvalsFor(t, parseOutward(text), map.folder, notes);
    const result = { summary: short(summary, 4000), exit_code: r.code, duration_s, approvals, commit, auto_push: cfg.auto_push, worker: cfg.identity };
    if (notes.length) result.notes = notes;
    const hb = await finish(t, ok ? "DONE" : "FAILED", summary, result);
    return Object.assign({}, hb, { approvals });
  }

  async function tick() {
    if (busy) return { busy: true };
    busy = true;
    try {
      const why = await killSwitch("worker idle");
      if (why) { once("ks:" + why, "kill switch / not ready: " + why + " (no claims)"); return { skipped: why }; }
      seen.delete("ks:dispatch_paused");
      seen.delete("ks:writes_frozen");
      const res = await api.listMine();
      if (res && hbFlags) hbFlags.dispatch_paused = !!res.dispatch_paused; // listMine is a fresher dispatch_paused
      if (!res || res.dispatch_paused) return { skipped: "dispatch_paused" };
      // Unclaimed-task alert (notify only): log it once per task, NEVER claim it. R2/R3: this worker works only tasks handed to it.
      if (Array.isArray(res.stale_alerts)) {
        for (const a of res.stale_alerts.slice(0, 5)) {
          if (typeof a !== "string") continue;
          const line = a.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").slice(0, 200);
          once("stale:" + line.replace(/, waiting \d+ min$/, ""), "stale-task alert (notify only, not claimed): " + line);
        }
      }
      const tasks = (res.tasks || []).filter((t) => isForMe(t, cfg.identity) && ID_RE.test(String(t.id)))
        .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      for (const t of tasks) {
        if (!isAllowed(t, cfg)) { once("deny:" + t.id, "task " + t.id + " refused: assigner is not the director (accept_director=" + cfg.accept_director + ") and not in allow_assigned_by (not claimed)"); continue; }
        return await runTask(t); // one task per tick, one at a time
      }
      return { idle: true };
    } finally {
      busy = false;
    }
  }

  return { tick, runTask };
}

// ------------------------------------------------------------------ linger loop (mode b)
// launchd wakes the worker every 30 min (StartInterval) or on demand (launchctl kickstart, no -k). A wake checks the
// inbox once: nothing to do -> exit 0 at once (near-zero idle cost). A task worked -> linger: check the inbox every
// intervalMs until windowMs have passed since the LAST task finished (each new task restarts the window), then exit 0.
// Pure and clock-injected so tests (and the live proof) can drive it with short values.
export async function runUntilIdle(o) {
  let deadline = null;
  let ticks = 0;
  for (;;) {
    let r = null;
    try { r = await o.tick(); } catch (err) { o.log("tick error " + codeOf(err)); }
    ticks++;
    if (r && !r.idle && !r.busy && !r.skipped) {
      deadline = o.now() + o.windowMs;
      o.log("task handled; linger window restarts: " + Math.round(o.windowMs / 1000) + "s, checking every " + Math.round(o.intervalMs / 1000) + "s");
    } else if (deadline === null) {
      return { reason: "idle", ticks };
    }
    const left = deadline - o.now();
    if (left <= 0) return { reason: "window_over", ticks };
    await o.sleep(Math.min(o.intervalMs, left));
  }
}

// ------------------------------------------------------------------ main
async function main() {
  const home = homedir();
  const dir = join(home, ".agency-board");
  const logFile = join(dir, "worker.log");
  const log = (line) => {
    try { appendFileSync(logFile, new Date().toISOString() + " " + line + "\n", { mode: 0o600 }); } catch (err) { /* ignore */ }
  };
  const once = process.argv.indexOf("--once") >= 0;
  let cfg;
  let token;
  try {
    const path = process.env.AGENCY_BOARD_WORKER_CONFIG || join(dir, "worker.json");
    cfg = loadConfig(JSON.parse(readFileSync(path, "utf8")), process.env, home);
    token = readFileSync(cfg.token_file, "utf8").trim();
    if (!/^agency-board_codex_[A-Za-z0-9_-]+$/.test(token)) throw new Error("token_file does not hold a codex token");
  } catch (err) {
    // Mode b has no launchd restart loop: launchd retries at the next StartInterval wake, so there is nothing to throttle.
    log("config error: " + (err && err.message ? err.message : "unreadable") + "; exit 78 (next launchd wake retries)");
    process.exit(78);
  }
  try { chmodSync(logFile, 0o600); } catch (err) { /* ignore */ }
  const worker = createWorker({ cfg, api: makeApi(cfg.base_url, token), log });
  log("worker v" + VERSION + " started as " + cfg.identity + " linger=" + cfg.linger_window_seconds + "s/" + cfg.linger_interval_seconds + "s auto_push=" + cfg.auto_push + " accept_director=" + cfg.accept_director + " allow=" + cfg.allow_assigned_by.length + " default_workdirs=" + cfg.default_workdirs + " folders=" + Object.keys(cfg.folders).length);
  if (once) {
    try {
      const r = await worker.tick();
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    } catch (err) {
      log("tick error " + codeOf(err));
      process.exit(1);
    }
  }
  const out = await runUntilIdle({
    tick: () => worker.tick(), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    windowMs: cfg.linger_window_seconds * 1000, intervalMs: cfg.linger_interval_seconds * 1000, log,
  });
  log("worker exit 0: " + out.reason + " after " + out.ticks + " check(s)");
  process.exit(0);
}

// Main guard: compare against the symlink-resolved script path (/tmp -> /private/tmp, symlinked HOME).
export function isMain(argv1, metaUrl) {
  if (!argv1) return false;
  let p = argv1;
  try { p = realpathSync(argv1); } catch (err) { /* fall back to the plain path */ }
  return metaUrl === pathToFileURL(p).href || metaUrl === pathToFileURL(argv1).href;
}
if (isMain(process.argv[1], import.meta.url)) main();
`;
