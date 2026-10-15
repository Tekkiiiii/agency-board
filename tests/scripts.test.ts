import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokenPrefixLength } from "../lib/auth";
import { CONNECT_SH } from "../lib/scripts/connectSh";
import { HOOK_LINE_PREFIXES } from "./hookLines";
import { CONNECT_PS1 } from "../lib/scripts/connectPs1";
import { LINGER_SH } from "../lib/scripts/lingerSh";
import * as connectShMod from "../lib/scripts/connectSh";
import * as connectPs1Mod from "../lib/scripts/connectPs1";
import * as lingerShMod from "../lib/scripts/lingerSh";
import * as workerMjsMod from "../lib/scripts/workerMjs";

// Fails fast if anything ever dials it (port 9 = discard, nothing listens), and the
// stub curl below never touches the network anyway.
const STUB_BASE = "http://127.0.0.1:9";
const FAKE_TOKEN = "agency-board_claude_FAKEtoken0000000000"; // fake, never a real token

const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0;

/** The heartbeat.sh body exactly as connect.sh writes it (before base substitution). */
function heartbeatShTemplate(): string {
  const m = CONNECT_SH.match(/<<'HBEOF'\n([\s\S]*?)\nHBEOF\n/);
  if (!m) throw new Error("heartbeat heredoc not found in CONNECT_SH");
  return m[1];
}

function heartbeatPs1Template(): string {
  const m = CONNECT_PS1.match(/\$hbText = @'\n([\s\S]*?)\n'@/);
  if (!m) throw new Error("heartbeat here-string not found in CONNECT_PS1");
  return m[1];
}

describe("connect.sh", () => {
  it("parses with /bin/sh -n", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-connect-"));
    try {
      const f = join(dir, "connect.sh");
      writeFileSync(f, CONNECT_SH);
      execFileSync("/bin/sh", ["-n", f], { stdio: "pipe" }); // throws on syntax error
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // '${' alone is valid POSIX (and the Hermes YAML block needs a literal ${AGENCY_BOARD_TOKEN_HERMES}),
  // so only bash-only parameter expansions are banned.
  it.each([
    ["[[ test", /\[\[ /],
    ["${x,,} / ${x^^} case conversion", /\$\{[^}]*(,,|\^\^)\}/],
    ["declare -A", /declare -A/],
    ["local (as a command)", /^\s*local\s/m],
    ["arrays", /\b[A-Za-z_]\w*=\(/],
    // embedded JXA has `function f(args) {`, so only the bash form `function f {` / `function f() {` is banned
    ["function keyword", /^\s*function\s+\w+\s*(\(\s*\))?\s*\{/m],
  ])("has no bash-only construct: %s", (_name, re) => {
    expect(CONNECT_SH).not.toMatch(re);
  });

  it("carries the base-url placeholder and never uses jq", () => {
    expect(CONNECT_SH).toContain("__AGENCY_BOARD_BASE_URL__");
    expect(CONNECT_SH).not.toMatch(/\bjq\b/);
  });
});

describe("heartbeat.sh (written by connect.sh)", () => {
  it("fetches the inbox only inside the session-start branch, 3 s timeout, always exits 0", () => {
    const hb = heartbeatShTemplate();
    const inbox = hb.split("\n").filter((l) => l.includes("/api/v1/inbox"));
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatch(/curl -fsS -m 3 /);
    expect(inbox[0]).toContain("?format=text");
    expect(hb).toMatch(/if \[ "\$1" = session-start \]; then\n\s+if \[ -s "\$HOME\/\.agency-board\/guide\.txt" \]; then echo "[^"\n]*guide\.txt"; fi\n\s+ab_auth "\$T" \| curl -fsS -m 3 -K - [^\n]*\/api\/v1\/inbox\?format=text[^\n]*\|\| true\nfi/);
    // the guide is only pointed at (one line), never dumped into the session
    expect(hb).not.toMatch(/cat [^\n]*guide\.txt/);
    expect(hb.trimEnd().split("\n").pop()).toBe("exit 0");
  });
});

// Hermetic: temp HOME, stub curl/claude/codex/hermes/osascript first on PATH that only log
// their argv; nothing reaches the network or the real ~/.claude / ~/.agency-board.
describe("connect.sh --hooks-only", () => {
  let dir: string;
  let home: string;
  let bin: string;
  let script: string;
  let log: string;

  const stub = (name: string, body: string) => {
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(f, 0o755);
  };
  // minimal env on purpose (no inherited AGENCY_BOARD_* vars); cast because Next's types make NODE_ENV required
  const env = (extra: Record<string, string> = {}) =>
    ({ HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...extra }) as unknown as NodeJS.ProcessEnv;
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("/bin/sh", ["-s", ...args], { input: readFileSync(script, "utf8"), env: env(extra), encoding: "utf8" });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  const writeToken = () => {
    mkdirSync(join(home, ".agency-board"), { recursive: true });
    writeFileSync(join(home, ".agency-board", "claude.token"), FAKE_TOKEN + "\n", { mode: 0o600 });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-hooks-"));
    home = join(dir, "home");
    bin = join(dir, "bin");
    log = join(dir, "calls.log");
    mkdirSync(home);
    mkdirSync(bin);
    script = join(dir, "connect.sh");
    writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(STUB_BASE));
    stub("curl", "exit 7");
    stub("claude", "exit 0");
    stub("codex", "exit 0");
    stub("hermes", "exit 0");
    stub("osascript", "echo added");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.each([
    ["sh -s -- --hooks-only", ["--", "--hooks-only"], {}],
    ["flag after a code", ["ABCD2345", "--hooks-only"], {}],
    ["AGENCY_BOARD_HOOKS_ONLY=1", [], { AGENCY_BOARD_HOOKS_ONLY: "1" }],
  ])("%s: rewrites only the hook files, no exchange, no MCP edits", (_n, args, extra) => {
    writeToken();
    const r = run(args as string[], extra as Record<string, string>);
    expect(r.status, r.stderr).toBe(0);
    const c = calls();
    expect(c).not.toContain("connect/exchange");
    // the only HTTP call is the best-effort agent-guide download (stub curl fails -> non-fatal)
    const curls = c.split("\n").filter((l) => l.startsWith("curl "));
    expect(curls).toHaveLength(1);
    expect(curls[0]).toMatch(/^curl -fsS -m 10 .*\/api\/v1\/guide\?format=text$/);
    expect(c).not.toMatch(/^(claude|codex|hermes) /m);
    expect(c).toMatch(/^osascript -l JavaScript .*\/home\/\.claude\/settings\.json claude$/m);
    const hb = readFileSync(join(home, ".agency-board", "heartbeat.sh"), "utf8");
    expect(hb).toContain(`${STUB_BASE}/api/v1/heartbeat`);
    expect(hb).toContain(`${STUB_BASE}/api/v1/inbox?format=text`);
    expect(hb).not.toContain("@AGENCY_BOARD_API_BASE@");
    // only the AGENTS.md pointer block is written under .codex; config.toml stays untouched
    expect(existsSync(join(home, ".codex", "AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, ".codex", "config.toml"))).toBe(false);
    expect(existsSync(join(home, ".zshrc"))).toBe(false);
    expect(existsSync(join(home, ".hermes"))).toBe(false);
    expect(r.stdout).not.toContain(FAKE_TOKEN);
    expect(r.stdout).toContain(FAKE_TOKEN.slice(0, tokenPrefixLength("claude")));
  });

  it("fails with a clear error when there is no existing claude token", () => {
    const r = run(["--", "--hooks-only"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no existing .*claude\.token/);
    expect(calls()).not.toMatch(/^(curl|claude|osascript) /m);
    expect(existsSync(join(home, ".agency-board", "heartbeat.sh"))).toBe(false);
  });

  it("still rejects unknown options", () => {
    writeToken();
    const r = run(["--", "--hooks-onyl"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown option");
  });

  it("installed heartbeat.sh prints the inbox on session-start only, silent + exit 0 on failure", () => {
    writeToken();
    expect(run(["--", "--hooks-only"]).status).toBe(0);
    const hb = join(home, ".agency-board", "heartbeat.sh");
    // stub curl: heartbeat POST prints nothing, inbox GET prints a body
    stub("curl", 'case "$*" in *inbox*) echo "agency-board: no pending tasks for claude@test" ;; esac\nexit 0');
    rmSync(log, { force: true });
    const start = spawnSync("/bin/sh", [hb, "session-start"], { env: env(), encoding: "utf8" });
    expect(start.status).toBe(0);
    expect(start.stdout).toBe("agency-board: no pending tasks for claude@test\n");
    expect(calls()).toMatch(/-m 3 .*\/api\/v1\/inbox\?format=text/);

    rmSync(log, { force: true });
    const stop = spawnSync("/bin/sh", [hb, "stop"], { env: env(), encoding: "utf8" });
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    expect(calls()).not.toContain("inbox");
    expect(calls()).toContain("/api/v1/heartbeat");

    stub("curl", "echo 'curl: (7) Failed to connect' >&2; exit 7");
    const fail = spawnSync("/bin/sh", [hb, "session-start"], { env: env(), encoding: "utf8" });
    expect(fail.status).toBe(0);
    expect(fail.stdout).toBe("");
    expect(fail.stderr).toBe("");
  });

  // stub curl that writes $body to the -o target for URLs containing $match
  const curlWriting = (match: string, body: string) =>
    stub("curl", [
      'out=""; prev=""',
      'for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done',
      `case "$*" in *${match}*) printf '%s\\n' '${body}' > "$out"; exit 0 ;; esac`,
      "exit 7",
    ].join("\n"));

  it("saves the agent guide to ~/.agency-board/guide.txt; session-start prints one pointer line, not the guide", () => {
    writeToken();
    curlWriting("api/v1/guide", "GUIDE BODY LINE");
    const r = run(["--", "--hooks-only"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(home, ".agency-board", "guide.txt"), "utf8")).toBe("GUIDE BODY LINE\n");
    expect(calls()).toMatch(/^curl .*-K - .*\/api\/v1\/guide\?format=text$/m); // token rides on stdin, not argv
    expect(calls()).not.toContain(FAKE_TOKEN);
    stub("curl", 'case "$*" in *inbox*) echo "agency-board: no pending tasks" ;; esac\nexit 0');
    const hb = join(home, ".agency-board", "heartbeat.sh");
    const start = spawnSync("/bin/sh", [hb, "session-start"], { env: env(), encoding: "utf8" });
    const lines = start.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^agency-board: .*read ~\/\.agency-board\/guide\.txt$/);
    expect(start.stdout).not.toContain("GUIDE BODY LINE");
    const stop = spawnSync("/bin/sh", [hb, "stop"], { env: env(), encoding: "utf8" });
    expect(stop.stdout).toBe("");
  });

  describe("codex AGENTS.md pointer block", () => {
    const AG = () => join(home, ".codex", "AGENTS.md");
    const count = (t: string, re: RegExp) => (t.match(re) || []).length;

    it("is written once when the file and dir are missing, with the three pointers and no confidential-project wording", () => {
      writeToken();
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const t = readFileSync(AG(), "utf8");
      expect(count(t, /<!-- BEGIN agency-board -->/g)).toBe(1);
      expect(count(t, /<!-- END agency-board -->/g)).toBe(1);
      expect(t).toContain("~/.agency-board/guide.txt");
      expect(t).toContain(`${STUB_BASE}/llms.txt`);
      expect(t).toContain(`GET ${STUB_BASE}/api/v1/guide`);
      expect(t).not.toMatch(/project\/confidential/i);
      expect(r.stdout).toContain(`agent guide: ${STUB_BASE}/llms.txt | full: GET ${STUB_BASE}/api/v1/guide`);
    });

    it("rerun keeps exactly one block and is byte-identical", () => {
      writeToken();
      run(["--", "--hooks-only"]);
      const first = readFileSync(AG(), "utf8");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const t = readFileSync(AG(), "utf8");
      expect(t).toBe(first);
      expect(count(t, /<!-- BEGIN agency-board -->/g)).toBe(1);
    });

    it("preserves user content above and below, and replaces a stale block in place", () => {
      writeToken();
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(AG(), "# My rules\nbe nice\n\n<!-- BEGIN agency-board -->\nOLD STALE LINE\n<!-- END agency-board -->\n\n## After\nkeep me\n");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const t = readFileSync(AG(), "utf8");
      expect(t).not.toContain("OLD STALE LINE");
      expect(count(t, /<!-- BEGIN agency-board -->/g)).toBe(1);
      expect(t.startsWith("# My rules\nbe nice\n\n<!-- BEGIN agency-board -->\n")).toBe(true);
      expect(t.endsWith("<!-- END agency-board -->\n\n## After\nkeep me\n")).toBe(true);
    });

    it("appends after existing content without a trailing newline, keeping it intact", () => {
      writeToken();
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(AG(), "only user line");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const t = readFileSync(AG(), "utf8");
      expect(t.startsWith("only user line\n\n<!-- BEGIN agency-board -->\n")).toBe(true);
      expect(count(t, /<!-- BEGIN agency-board -->/g)).toBe(1);
    });

    it("is not called from the --worker paths", () => {
      const calls = CONNECT_SH.match(/^\s+step_codex_guide$/gm) || [];
      expect(calls).toHaveLength(2); // main + hooks_only only
      const worker = CONNECT_SH.slice(CONNECT_SH.indexOf("worker_install() {"), CONNECT_SH.indexOf("# hooks_only:"));
      expect(worker).not.toContain("step_codex_guide");
    });
  });

  describe("--worker", () => {
    const PLIST = () => join(home, "Library", "LaunchAgents", "com.agency-board.worker.plist");
    const writeCodexToken = () => {
      mkdirSync(join(home, ".agency-board"), { recursive: true });
      writeFileSync(join(home, ".agency-board", "codex.token"), "agency-board_codex_FAKEtoken00000000000\n", { mode: 0o600 });
    };
    beforeEach(() => {
      stub("node", "exit 0");
      // Fake sleep: the retry/wait loops must never really wait. It only counts its calls.
      writeFileSync(join(bin, "sleep"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, "sleeps.log")}"\nexit 0\n`);
      chmodSync(join(bin, "sleep"), 0o755);
      // Realistic launchctl: bootout is asynchronous (print keeps succeeding for
      // lc/print.lag more calls and bootstrap fails with exit 5 while the old service tears
      // down); bootstrap also fails lc/bootstrap.fail times; print fails (113) when not loaded.
      stub(
        "launchctl",
        `D="${join(dir, "lc")}"
mkdir -p "$D"
rd() { cat "$D/$1" 2>/dev/null || echo 0; }
case "$1" in
  bootout)
    if [ -f "$D/loaded" ]; then rm -f "$D/loaded"; rd print.lag > "$D/teardown"; exit 0; fi
    exit 113 ;;
  print)
    n=$(rd teardown)
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$D/teardown"; exit 0; fi
    [ -f "$D/loaded" ] && exit 0
    exit 113 ;;
  bootstrap)
    f=$(rd bootstrap.fail)
    if [ "$(rd teardown)" -gt 0 ] || [ "$f" -gt 0 ]; then
      [ "$f" -gt 0 ] && echo $((f - 1)) > "$D/bootstrap.fail"
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    touch "$D/loaded"; exit 0 ;;
esac
exit 0`,
      );
      curlWriting("worker.mjs", "// agency-board auto-worker (test copy)");
    });
    const lcSet = (name: string, v: number) => {
      mkdirSync(join(dir, "lc"), { recursive: true });
      writeFileSync(join(dir, "lc", name), `${v}\n`);
    };
    const lcLoaded = () => existsSync(join(dir, "lc", "loaded"));
    const lcCalls = (verb: string) => calls().split("\n").filter((l) => l.startsWith(`launchctl ${verb} `));
    const sleeps = () => (existsSync(join(dir, "sleeps.log")) ? readFileSync(join(dir, "sleeps.log"), "utf8").split("\n").filter(Boolean).length : 0);

    it("installs worker.mjs, a worker.json template and the LaunchAgent; no exchange, no MCP edits", () => {
      writeCodexToken();
      const r = run(["--", "--worker"], { AGENCY_BOARD_WORKER_IDENTITY: "codex@laptop" });
      expect(r.status, r.stderr).toBe(0);
      const c = calls();
      expect(c).not.toContain("connect/exchange");
      expect(c).toMatch(/^curl -fsS -m 30 -o .* http:\/\/127\.0\.0\.1:9\/worker\.mjs$/m);
      expect(c).toMatch(/^launchctl bootout gui\/\d+\/com\.agency-board\.worker$/m);
      expect(c).toMatch(/^launchctl bootstrap gui\/\d+ .*com\.agency-board\.worker\.plist$/m);
      expect(c).not.toMatch(/^(claude|codex|hermes|osascript) /m);
      expect(readFileSync(join(home, ".agency-board", "worker.mjs"), "utf8")).toContain("agency-board auto-worker");
      const cfg = JSON.parse(readFileSync(join(home, ".agency-board", "worker.json"), "utf8"));
      expect(cfg).toMatchObject({ base_url: STUB_BASE, identity: "codex@laptop", accept_director: true, allow_assigned_by: [], default_workdirs: true, folders: {}, auto_push: false });
      const pl = readFileSync(PLIST(), "utf8");
      expect(pl).toContain(`<string>${bin}/node</string>`);
      expect(pl).toContain(`<string>${home}/.agency-board/worker.mjs</string>`);
      expect(pl).toContain(`<key>StandardOutPath</key><string>${home}/.agency-board/worker.log</string>`);
      // mode b (2026-10-13): launchd wakes the worker every 30 min; no KeepAlive (the worker lingers 30 min after a task, then exits 0)
      expect(pl).toContain("<key>RunAtLoad</key><true/>");
      expect(pl).toContain("<key>StartInterval</key><integer>1800</integer>");
      expect(pl).not.toContain("KeepAlive");
      expect(existsSync(join(home, ".codex"))).toBe(false);
      expect(existsSync(join(home, ".claude"))).toBe(false);
      expect(r.stdout).not.toContain("agency-board_codex_FAKEtoken00000000000");
      expect(r.stdout).toMatch(/caffeinate/);
    });

    it("re-running keeps an edited worker.json; identity defaults to a CHANGE-ME placeholder", () => {
      writeCodexToken();
      expect(run(["--", "--worker"]).status).toBe(0);
      const f = join(home, ".agency-board", "worker.json");
      expect(JSON.parse(readFileSync(f, "utf8")).identity).toBe("codex@CHANGE-ME");
      writeFileSync(f, '{"identity":"codex@edited"}\n');
      const r = run(["--", "--worker"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(f, "utf8")).toBe('{"identity":"codex@edited"}\n');
    });

    it("--worker-uninstall boots out and removes the plist, keeps worker.json", () => {
      writeCodexToken();
      expect(run(["--", "--worker"]).status).toBe(0);
      rmSync(log, { force: true });
      const r = run(["--", "--worker-uninstall"]);
      expect(r.status, r.stderr).toBe(0);
      expect(calls()).toMatch(/^launchctl bootout gui\/\d+\/com\.agency-board\.worker$/m);
      expect(calls()).not.toMatch(/^curl /m);
      expect(existsSync(PLIST())).toBe(false);
      expect(existsSync(join(home, ".agency-board", "worker.json"))).toBe(true);
    });

    it("loads the agent and verifies it with launchctl print; clean run needs no retries or sleeps", () => {
      writeCodexToken();
      const r = run(["--", "--worker"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/installed and loaded \(com\.agency-board\.worker\)/);
      expect(lcCalls("bootstrap")).toHaveLength(1);
      expect(lcCalls("print").length).toBeGreaterThanOrEqual(2); // after bootout and after bootstrap
      expect(lcLoaded()).toBe(true);
      expect(sleeps()).toBe(0);
    });

    it("reinstall waits for the async bootout to finish before bootstrapping (the old race)", () => {
      writeCodexToken();
      expect(run(["--", "--worker"]).status).toBe(0);
      rmSync(log, { force: true });
      lcSet("print.lag", 3); // launchd keeps the old service visible for 3 more print calls
      const r = run(["--", "--worker"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/WARNING/);
      expect(r.stdout).toMatch(/installed and loaded/);
      expect(sleeps()).toBe(3);
      const verbs = calls().split("\n").filter((l) => l.startsWith("launchctl ")).map((l) => l.split(" ")[1]);
      expect(verbs.indexOf("bootout")).toBeLessThan(verbs.indexOf("bootstrap"));
      // bootout, then print x4 (3 still listed, 1 gone), then a single bootstrap that works
      expect(verbs.slice(0, 7)).toEqual(["bootout", "print", "print", "print", "print", "bootstrap", "print"]);
      expect(lcLoaded()).toBe(true);
    });

    it("retries a failing bootstrap and succeeds without a warning", () => {
      writeCodexToken();
      lcSet("bootstrap.fail", 2);
      const r = run(["--", "--worker"]);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).not.toMatch(/WARNING/);
      expect(r.stdout).toMatch(/installed and loaded/);
      expect(lcCalls("bootstrap")).toHaveLength(3);
      expect(sleeps()).toBe(2);
      expect(lcLoaded()).toBe(true);
    });

    it("reports a final bootstrap failure: error text, manual command, NOT loaded, exit 1", () => {
      writeCodexToken();
      lcSet("bootstrap.fail", 99);
      const r = run(["--", "--worker"]);
      expect(r.status).toBe(1);
      expect(lcCalls("bootstrap")).toHaveLength(5);
      expect(sleeps()).toBe(4); // no pointless sleep after the last try
      expect(r.stderr).toMatch(/WARNING: launchctl bootstrap failed after 5 tries: Bootstrap failed: 5: Input\/output error\./);
      expect(r.stderr).toMatch(/NOT loaded\. Run: launchctl bootstrap gui\/\d+ .*com\.agency-board\.worker\.plist/);
      expect(r.stdout).toMatch(/LaunchAgent is NOT loaded/);
      expect(r.stdout).toMatch(/Warnings:/);
      expect(r.stdout).not.toMatch(/installed and loaded/);
      expect(lcLoaded()).toBe(false);
      // files are still in place so the printed manual command can work
      expect(existsSync(PLIST())).toBe(true);
    });

    it("--worker-uninstall waits for the async bootout, so uninstall then install is safe", () => {
      writeCodexToken();
      expect(run(["--", "--worker"]).status).toBe(0);
      rmSync(log, { force: true });
      lcSet("print.lag", 2);
      const u = run(["--", "--worker-uninstall"]);
      expect(u.status, u.stderr).toBe(0);
      expect(lcCalls("print")).toHaveLength(3); // 2 still listed, then gone
      expect(sleeps()).toBe(2);
      lcSet("print.lag", 0);
      const i = run(["--", "--worker"]);
      expect(i.status, i.stderr).toBe(0);
      expect(i.stdout).toMatch(/installed and loaded/);
      expect(lcLoaded()).toBe(true);
    });

    it("--worker-uninstall warns and exits 1 when the service never goes away", () => {
      writeCodexToken();
      expect(run(["--", "--worker"]).status).toBe(0);
      lcSet("print.lag", 999);
      const u = run(["--", "--worker-uninstall"]);
      expect(u.status).toBe(1);
      expect(u.stderr).toMatch(/WARNING: .*still loaded 10 s after launchctl bootout\. Run: launchctl bootout gui\/\d+\/com\.agency-board\.worker/);
      expect(existsSync(PLIST())).toBe(false);
    });

    it.each([
      ["no codex token", ["--", "--worker"], false, /no existing .*codex\.token/],
      ["combined with --hooks-only", ["--", "--worker", "--hooks-only"], true, /separate steps/],
      ["with a connect code", ["ABCD2345", "--worker"], true, /takes no connect code/],
    ])("refuses: %s", (_n, args, token, msg) => {
      if (token) writeCodexToken();
      const r = run(args as string[]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(msg as RegExp);
      expect(existsSync(PLIST())).toBe(false);
      expect(calls()).not.toMatch(/^launchctl bootstrap/m);
    });
  });
});

describe("connect.ps1 (Windows PowerShell 5.1)", () => {
  it.each([
    ["?? null-coalescing", /\?\?/],
    ["ternary ' ? '", / \? /],
    ["&& pipeline chain", /&&/],
    ["|| pipeline chain", /\|\|/],
  ])("has no PS7-only construct: %s", (_name, re) => {
    expect(CONNECT_PS1).not.toMatch(re);
  });

  it("heartbeat.ps1 fetches the inbox only on session-start (3 s, basic parsing) and always exits 0", () => {
    const hb = heartbeatPs1Template();
    expect(hb).toMatch(/if \(\$note -eq 'session-start'\) \{[\s\S]*Invoke-WebRequest -Uri '@AGENCY_BOARD_API_BASE@\/api\/v1\/inbox\?format=text'[^\n]*-TimeoutSec 3 -UseBasicParsing/);
    expect(hb.match(/\/api\/v1\/inbox/g)).toHaveLength(1);
    expect(hb.trimEnd().split("\n").pop()).toBe("exit 0");
    // one pointer line to the guide on session-start, never its content
    expect(hb).toMatch(/if \(\$note -eq 'session-start'\) \{\n\s+if \(Test-Path -LiteralPath \(Join-Path \$HOME '\.agency-board\\guide\.txt'\)\) \{ \[Console\]::Out\.WriteLine\('agency-board: [^']*guide\.txt'\) \}/);
    expect(hb).not.toMatch(/ReadAllText\([^)]*guide/);
  });

  it("downloads the agent guide best-effort, outside the hooks-only branch, never fatal", () => {
    const i = CONNECT_PS1.indexOf("/api/v1/guide?format=text");
    expect(i).toBeGreaterThan(CONNECT_PS1.indexOf("} else {", CONNECT_PS1.indexOf("if ($hooksOnly) {")));
    const block = CONNECT_PS1.slice(CONNECT_PS1.lastIndexOf("try {", i), CONNECT_PS1.indexOf("# 7. heartbeat hook", i));
    expect(block).toMatch(/-TimeoutSec 10 -UseBasicParsing/);
    expect(block).toMatch(/\} catch \{ Say 'agent guide not available yet/);
  });

  it("writes the Codex AGENTS.md marked block in both connect and hooks-only paths, replacing in place", () => {
    const i = CONNECT_PS1.indexOf("# 6c.");
    expect(i).toBeGreaterThan(CONNECT_PS1.indexOf("# 6b."));
    expect(i).toBeLessThan(CONNECT_PS1.indexOf("# 7. heartbeat hook"));
    // outside the else (connect-only) branch: after the closing brace of if/else, at 4-space indent
    expect(CONNECT_PS1.slice(i - 10, i)).toMatch(/\n\n    $/);
    const blk = CONNECT_PS1.slice(i, CONNECT_PS1.indexOf("# 7. heartbeat hook"));
    expect(blk).toContain("'<!-- BEGIN agency-board -->'");
    expect(blk).toContain("'<!-- END agency-board -->'");
    expect(blk).toContain("AGENTS.md");
    expect(blk).toContain("/llms.txt");
    expect(blk).toContain("/api/v1/guide");
    expect(blk).toContain("~/.agency-board/guide.txt");
    expect(blk).toMatch(/Write-IfChanged \$agf /);
    expect(blk).toMatch(/\} catch \{ Warn /);
    expect(CONNECT_PS1).not.toMatch(/project\/confidential/i);
    expect(CONNECT_PS1).toMatch(/Say \('agent guide: ' \+ \$apiBase \+ '\/llms\.txt \| full: GET '/);
  });

  it("supports AGENCY_BOARD_HOOKS_ONLY without a code exchange", () => {
    expect(CONNECT_PS1).toMatch(/\$hooksOnly = \(\[string\]\$env:AGENCY_BOARD_HOOKS_ONLY -eq '1'\)/);
    // the exchange call lives in the else branch of if ($hooksOnly)
    const i = CONNECT_PS1.indexOf("if ($hooksOnly) {");
    const j = CONNECT_PS1.indexOf("} else {", i);
    const k = CONNECT_PS1.indexOf("/api/connect/exchange");
    expect(i).toBeGreaterThan(0);
    expect(k).toBeGreaterThan(j);
    expect(CONNECT_PS1.slice(i, j)).not.toMatch(/Invoke-RestMethod|Invoke-Native|SetEnvironmentVariable|Set-Block|WriteAllText/);
  });

  it.skipIf(!HAS_PWSH)("parses with the PowerShell parser (script + heartbeat.ps1)", () => {
    const d = mkdtempSync(join(tmpdir(), "hub-ps1-"));
    try {
      for (const [name, text] of [["connect.ps1", CONNECT_PS1], ["heartbeat.ps1", heartbeatPs1Template()]] as const) {
        const f = join(d, name);
        writeFileSync(f, text);
        const out = execFileSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
          `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${f}', [ref]$null, [ref]$e); $e.Count`],
          { encoding: "utf8" });
        expect(out.trim(), name).toBe("0");
      }
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("forces TLS 1.2 and carries the base-url placeholder", () => {
    expect(CONNECT_PS1).toContain("__AGENCY_BOARD_BASE_URL__");
    // accept either the plain assignment or the (better) additive -bor form
    expect(CONNECT_PS1).toMatch(/SecurityProtocol\s*=\s*(?:'Tls12'|\[Net\.ServicePointManager\]::SecurityProtocol\s+-bor\s+\[Net\.SecurityProtocolType\]::Tls12)/i);
  });
});

// ---- post-task linger window: installer side (real osascript, so macOS only) ----
const HAS_OSASCRIPT = spawnSync("osascript", ["-l", "JavaScript", "-e", "1"], { stdio: "ignore" }).status === 0;

describe.skipIf(!HAS_OSASCRIPT)("connect.sh linger install (temp HOME, real osascript)", () => {
  let dir: string;
  let home: string;
  let bin: string;
  let script: string;
  const AMD = () => join(home, ".agency-board");
  const SJ = () => join(home, ".claude", "settings.json");
  const CHJ = () => join(home, ".codex", "hooks.json");
  const stub = (name: string, body: string) => {
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/sh\n${body}\n`);
    chmodSync(f, 0o755);
  };
  const env = (extra: Record<string, string> = {}) =>
    ({ HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...extra }) as unknown as NodeJS.ProcessEnv;
  const run = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync("/bin/sh", ["-s", ...args], { input: readFileSync(script, "utf8"), env: env(extra), encoding: "utf8" });
  const writeTokens = (codex = false) => {
    mkdirSync(AMD(), { recursive: true });
    writeFileSync(join(AMD(), "claude.token"), FAKE_TOKEN + "\n", { mode: 0o600 });
    if (codex) writeFileSync(join(AMD(), "codex.token"), "agency-board_codex_testtoken00000000000\n", { mode: 0o600 });
  };
  const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
  const cmds = (o: any, ev: string): string[] => (o.hooks[ev] || []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
  const baks = (d: string, base: string) => readdirSync(d).filter((f) => f.startsWith(base + ".bak-agency-board-"));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hub-linger-inst-"));
    home = join(dir, "home");
    bin = join(dir, "bin");
    mkdirSync(home);
    mkdirSync(bin);
    script = join(dir, "connect.sh");
    writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(STUB_BASE));
    stub("curl", "exit 7");
    stub("claude", "exit 0");
    stub("codex", "exit 0");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("--hooks-only installs linger.sh (base substituted) and registers PostToolUse + Stop(86400 s) next to the heartbeat hooks", () => {
    writeTokens();
    const r = run(["--", "--hooks-only"]);
    expect(r.status, r.stderr).toBe(0);
    const l = readFileSync(join(AMD(), "linger.sh"), "utf8");
    expect(l).toContain(`${STUB_BASE}/api/v1/tasks?mine=1&status=open`);
    expect(l).not.toContain("@AGENCY_BOARD_API_BASE@");
    expect(l).not.toContain("__AGENCY_BOARD_LINGER_SH__");
    expect(spawnSync("/bin/sh", ["-n", join(AMD(), "linger.sh")]).status).toBe(0);
    const s = readJson(SJ());
    expect(cmds(s, "SessionStart")).toEqual(["sh ~/.agency-board/heartbeat.sh session-start"]);
    expect(cmds(s, "Stop")).toEqual(["sh ~/.agency-board/heartbeat.sh stop", "sh ~/.agency-board/linger.sh stop claude"]);
    expect(cmds(s, "PostToolUse")).toEqual(["sh ~/.agency-board/linger.sh mark claude", "sh ~/.agency-board/linger.sh kick claude"]);
    expect(s.hooks.PostToolUse[0].matcher).toBe("mcp__agency-board__complete_task");
    // same-machine handoff -> launchctl kickstart (instant worker pickup), fired after a handoff or a post_task
    expect(s.hooks.PostToolUse[1].matcher).toBe("mcp__agency-board__handoff|mcp__agency-board__post_task");
    const stop = s.hooks.Stop.flatMap((g: any) => g.hooks).find((h: any) => h.command.includes("linger.sh"));
    expect(stop.timeout).toBe(86400);
    expect(existsSync(CHJ())).toBe(false); // no codex token: codex untouched
    expect(r.stdout).not.toContain(FAKE_TOKEN);
  });

  it("is idempotent: a second run changes nothing (settings.json byte-identical, no new backup, no duplicate hooks)", () => {
    writeTokens();
    expect(run(["--", "--hooks-only"]).status).toBe(0);
    const before = readFileSync(SJ(), "utf8");
    const linger1 = readFileSync(join(AMD(), "linger.sh"), "utf8");
    const bakCount = baks(join(home, ".claude"), "settings.json").length;
    const r = run(["--", "--hooks-only"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(SJ(), "utf8")).toBe(before);
    expect(readFileSync(join(AMD(), "linger.sh"), "utf8")).toBe(linger1);
    expect(baks(join(home, ".claude"), "settings.json")).toHaveLength(bakCount);
    expect(baks(AMD(), "linger.sh")).toEqual([]);
    expect(r.stdout).toContain("heartbeat.sh, linger.sh and hooks already up to date");
    expect(r.stdout).not.toContain("Files changed");
    expect(cmds(readJson(SJ()), "Stop")).toHaveLength(2);
  });

  it("upgrades a heartbeat-only settings.json: adds just the linger hooks, keeps user hooks and keys, backs up first", () => {
    writeTokens();
    mkdirSync(join(home, ".claude"));
    const old = {
      model: "opus",
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/heartbeat.sh session-start" }] }],
        Stop: [{ matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/heartbeat.sh stop" }, { type: "command", command: "echo mine" }] }],
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo user-hook" }] }],
      },
    };
    writeFileSync(SJ(), JSON.stringify(old, null, 2) + "\n");
    const r = run(["--", "--hooks-only"]);
    expect(r.status, r.stderr).toBe(0);
    const s = readJson(SJ());
    expect(s.model).toBe("opus");
    expect(cmds(s, "SessionStart")).toEqual(["sh ~/.agency-board/heartbeat.sh session-start"]);
    expect(cmds(s, "Stop")).toEqual(["sh ~/.agency-board/heartbeat.sh stop", "echo mine", "sh ~/.agency-board/linger.sh stop claude"]);
    expect(cmds(s, "PostToolUse")).toEqual(["echo user-hook", "sh ~/.agency-board/linger.sh mark claude", "sh ~/.agency-board/linger.sh kick claude"]);
    const b = baks(join(home, ".claude"), "settings.json");
    expect(b).toHaveLength(1);
    expect(readJson(join(home, ".claude", b[0]))).toEqual(old);
  });

  it("does not touch an unparseable settings.json: warns, file unchanged", () => {
    writeTokens();
    mkdirSync(join(home, ".claude"));
    writeFileSync(SJ(), "{ not json");
    const r = run(["--", "--hooks-only"]);
    expect(r.status).toBe(0);
    expect(readFileSync(SJ(), "utf8")).toBe("{ not json");
    expect(r.stderr).toMatch(/could not add claude hooks/);
  });

  it("codex: with a codex token and ~/.codex, merges the SessionStart + linger hooks into hooks.json (existing hooks kept, idempotent, trust note)", () => {
    writeTokens(true);
    mkdirSync(join(home, ".codex"));
    const old = { hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "/bin/sh /x/some-user-hook.sh" }] }] } };
    writeFileSync(CHJ(), JSON.stringify(old, null, 2) + "\n");
    const r1 = run(["--", "--hooks-only"]);
    expect(r1.status, r1.stderr).toBe(0);
    expect(r1.stdout).toMatch(/Hooks need review/);
    expect(r1.stdout).toMatch(/Trust all and continue/);
    expect(r1.stdout).toMatch(/\/hooks/);
    expect(r1.stdout).not.toMatch(/run \/hooks in Codex and trust the agency-board linger hooks/); // old wording
    const h = readJson(CHJ());
    expect(cmds(h, "SessionStart")).toEqual(["/bin/sh /x/some-user-hook.sh", "sh ~/.agency-board/heartbeat.sh session-start codex"]); // user hook kept, managed one added
    expect(cmds(h, "UserPromptSubmit")).toEqual(["sh ~/.agency-board/linger.sh prompt codex"]); // arms $listen/$wait/$unlisten outside the sandbox
    expect(h.hooks.UserPromptSubmit[0].matcher).toBe("");
    expect(cmds(h, "Stop")).toEqual(["sh ~/.agency-board/linger.sh stop codex"]);
    expect(cmds(h, "PostToolUse")).toEqual(["sh ~/.agency-board/linger.sh mark codex", "sh ~/.agency-board/linger.sh kick codex"]);
    expect(h.hooks.PostToolUse[0].matcher).toBe("mcp__agency-board__complete_task");
    expect(h.hooks.Stop[0].hooks[0].timeout).toBe(86400);
    expect(JSON.stringify(h)).not.toContain("heartbeat.sh stop");
    const once = readFileSync(CHJ(), "utf8");
    const r2 = run(["--", "--hooks-only"]);
    expect(r2.status, r2.stderr).toBe(0);
    expect(readFileSync(CHJ(), "utf8")).toBe(once);
    expect(r2.stdout).not.toMatch(/trust/i);
    expect(r2.stdout).not.toMatch(/Hooks need review/);
    expect(baks(join(home, ".codex"), "hooks.json")).toHaveLength(1);
  });

  describe("codex SessionStart hook is managed by connect.sh (heartbeat.sh session-start codex)", () => {
    it("a codex install gets the managed SessionStart hook (startup|resume, statusMessage, context limit); other events untouched", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      const h = readJson(CHJ());
      expect(cmds(h, "SessionStart")).toEqual(["sh ~/.agency-board/heartbeat.sh session-start codex"]);
      expect(h.hooks.SessionStart).toHaveLength(1);
      expect(h.hooks.SessionStart[0].matcher).toBe("startup|resume");
      expect(h.hooks.SessionStart[0].hooks[0].statusMessage).toBe("Loading agency-board tasks");
      expect(h.hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(5000);
      expect(cmds(h, "UserPromptSubmit")).toEqual(["sh ~/.agency-board/linger.sh prompt codex"]);
      expect(cmds(h, "Interrupt")).toEqual(["sh ~/.agency-board/linger.sh interrupt codex"]);
    });

    it("is idempotent: a second run changes nothing and adds no duplicate SessionStart entry", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      const once = readFileSync(CHJ(), "utf8");
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      expect(readFileSync(CHJ(), "utf8")).toBe(once);
      expect(readJson(CHJ()).hooks.SessionStart).toHaveLength(1);
    });

    it("the hook prints pending tasks from codex.token (not claude.token), token only on curl stdin, silent + exit 0 on failure", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      const SEC = "agency-board_codex_SECRETSECRET0123456789abcdef";
      writeFileSync(join(AMD(), "codex.token"), SEC + "\n");
      const log = join(dir, "curl.log");
      stub("curl", `printf '%s\\n' "$*" >> "${log}"\ncase " $* " in *" -K - "*) cat >> "${log}.in" ;; esac\ncase "$*" in *inbox*) echo "agency-board: 1 pending task(s) for codex@m" ;; esac\nexit 0`);
      const ok = spawnSync("/bin/sh", [join(AMD(), "heartbeat.sh"), "session-start", "codex"], { env: env(), encoding: "utf8" });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("agency-board: 1 pending task(s) for codex@m");
      expect(readFileSync(log, "utf8")).not.toContain(SEC);
      expect(readFileSync(log, "utf8")).not.toMatch(/Bearer|Authorization/);
      expect(readFileSync(log + ".in", "utf8")).toContain(`Bearer ${SEC}`);
      expect(readFileSync(log + ".in", "utf8")).not.toContain(FAKE_TOKEN); // the claude token is not used in codex mode
      stub("curl", "exit 7");
      const bad = spawnSync("/bin/sh", [join(AMD(), "heartbeat.sh"), "session-start", "codex"], { env: env(), encoding: "utf8" });
      expect(bad.status).toBe(0);
      expect(bad.stdout).not.toMatch(/pending task/);
      expect(bad.stderr).toBe("");
      // unknown agent word or missing token: silent no-op, never a path escape
      const odd = spawnSync("/bin/sh", [join(AMD(), "heartbeat.sh"), "session-start", "../x"], { env: env(), encoding: "utf8" });
      expect(odd.status).toBe(0);
      expect(odd.stdout).toBe("");
    });
  });

  it("codex: no ~/.codex dir or no codex token means no hooks.json is created", () => {
    writeTokens(true);
    run(["--", "--hooks-only"]);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
    rmSync(join(AMD(), "codex.token"));
    run(["--", "--hooks-only"]);
    expect(existsSync(CHJ())).toBe(false);
  });

  it("full connect (file:// test hook): second run is a no-op for linger.sh, settings.json and hooks.json", () => {
    const resp = join(dir, "resp.json");
    writeFileSync(
      resp,
      JSON.stringify({ server_url: `${STUB_BASE}/api/mcp`, machine: "m1", token_claude: FAKE_TOKEN, token_codex: "agency-board_codex_testtoken00000000000" }),
    );
    writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(`file://${dir}`));
    mkdirSync(join(home, ".codex"));
    const go = () => run(["ABCD2345"], { AGENCY_BOARD_TEST_RESPONSE_FILE: resp });
    const r1 = go();
    expect(r1.status, r1.stderr).toBe(0);
    expect(existsSync(join(AMD(), "linger.sh"))).toBe(true);
    expect(cmds(readJson(CHJ()), "Stop")).toEqual(["sh ~/.agency-board/linger.sh stop codex"]);
    expect(cmds(readJson(CHJ()), "UserPromptSubmit")).toEqual(["sh ~/.agency-board/linger.sh prompt codex"]);
    const snap = [SJ(), CHJ(), join(AMD(), "linger.sh"), join(AMD(), "heartbeat.sh")].map((f) => readFileSync(f, "utf8"));
    const r2 = go();
    expect(r2.status, r2.stderr).toBe(0);
    expect([SJ(), CHJ(), join(AMD(), "linger.sh"), join(AMD(), "heartbeat.sh")].map((f) => readFileSync(f, "utf8"))).toEqual(snap);
    expect(r2.stdout).not.toMatch(/linger\.sh|settings\.json|hooks\.json/);
    expect(baks(join(home, ".claude"), "settings.json")).toEqual([]); // there was nothing to back up on the first run
    expect(baks(join(home, ".codex"), "hooks.json")).toEqual([]);
  });

  // ---- /listen /wait /unlisten: Stop timeout upgrade, slash commands (Claude), prompts + skills + Interrupt hook (Codex) ----
  describe("listen / wait / unlisten install", () => {
    const CMARK = "<!-- agency-board:commands v1 -->";
    const CMDS = () => join(home, ".claude", "commands");
    const CPROMPTS = () => join(home, ".codex", "prompts");
    const CSKILLS = () => join(home, ".agents", "skills");
    const dollarBrace = "$" + "{CLAUDE_SESSION_ID}";
    const bang = (s: string) => "!" + String.fromCharCode(96) + s + String.fromCharCode(96);
    const stopTimeouts = (o: any) => o.hooks.Stop.flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes("linger.sh")).map((h: any) => h.timeout);

    it("upgrades an already installed linger Stop hook from 1900 to 86400 (backup first, other hooks untouched), then is a no-op", () => {
      writeTokens();
      mkdirSync(join(home, ".claude"));
      const old = {
        model: "opus",
        hooks: {
          SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/heartbeat.sh session-start" }] }],
          Stop: [
            { matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/heartbeat.sh stop" }] },
            { matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/linger.sh stop claude", timeout: 1900 }] },
            { matcher: "", hooks: [{ type: "command", command: "echo mine", timeout: 5 }] },
          ],
          PostToolUse: [
            { matcher: "mcp__agency-board__complete_task", hooks: [{ type: "command", command: "sh ~/.agency-board/linger.sh mark claude" }] },
            { matcher: "mcp__agency-board__handoff|mcp__agency-board__post_task", hooks: [{ type: "command", command: "sh ~/.agency-board/linger.sh kick claude" }] },
          ],
        },
      };
      writeFileSync(SJ(), JSON.stringify(old, null, 2) + "\n");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const s = readJson(SJ());
      expect(stopTimeouts(s)).toEqual([86400]);
      expect(s.hooks.Stop[2].hooks[0].timeout).toBe(5); // a user hook is not touched
      expect(cmds(s, "Stop")).toEqual(["sh ~/.agency-board/heartbeat.sh stop", "sh ~/.agency-board/linger.sh stop claude", "echo mine"]);
      const b = baks(join(home, ".claude"), "settings.json");
      expect(b).toHaveLength(1);
      expect(readJson(join(home, ".claude", b[0]))).toEqual(old);
      const once = readFileSync(SJ(), "utf8");
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      expect(readFileSync(SJ(), "utf8")).toBe(once);
      expect(baks(join(home, ".claude"), "settings.json")).toHaveLength(1);
    });

    it("never lowers a higher timeout and leaves a timeout-less non-linger hook alone", () => {
      writeTokens();
      mkdirSync(join(home, ".claude"));
      const old = { hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/linger.sh stop claude", timeout: 99999 }] }] } };
      writeFileSync(SJ(), JSON.stringify(old, null, 2) + "\n");
      run(["--", "--hooks-only"]);
      expect(stopTimeouts(readJson(SJ()))).toEqual([99999]);
    });

    it("claude: installs listen.md, wait.md, unlisten.md (frontmatter, marker after it, bang arm line, allowed-tools), idempotent rerun", () => {
      writeTokens();
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(CMDS()).sort()).toEqual(["listen.md", "unlisten.md", "wait.md"]);
      const want: Array<[string, string]> = [
        ["listen", `sh ~/.agency-board/linger.sh arm claude listen "${dollarBrace}"`],
        ["wait", `sh ~/.agency-board/linger.sh arm claude wait "${dollarBrace}"`],
        ["unlisten", `sh ~/.agency-board/linger.sh disarm claude "${dollarBrace}"`],
      ];
      for (const [name, cmd] of want) {
        const t = readFileSync(join(CMDS(), `${name}.md`), "utf8");
        const lines = t.split("\n");
        expect(lines[0]).toBe("---");
        const end = lines.indexOf("---", 1);
        expect(end).toBeGreaterThan(1);
        const fm = lines.slice(1, end).join("\n");
        expect(fm).toMatch(/^description: .+/m);
        expect(fm).toMatch(/^disable-model-invocation: true$/m);
        expect(fm).toContain("allowed-tools: Bash(sh ~/.agency-board/linger.sh:*)");
        expect(lines[end + 1]).toBe(CMARK); // marker right after the frontmatter
        expect(lines).toContain(bang(cmd));
        expect(t).not.toContain("$ARGUMENTS");
        expect(t).not.toContain(FAKE_TOKEN);
      }
      const listen = readFileSync(join(CMDS(), "listen.md"), "utf8");
      expect(listen).toMatch(/list_tasks/);
      expect(listen).toMatch(/R2/);
      expect(readFileSync(join(CMDS(), "wait.md"), "utf8")).toMatch(/do NOT claim/i);
      // rerun: byte-identical, no new backups, nothing reported as changed
      const snap = readdirSync(CMDS()).map((f) => readFileSync(join(CMDS(), f), "utf8"));
      const r2 = run(["--", "--hooks-only"]);
      expect(r2.status, r2.stderr).toBe(0);
      expect(readdirSync(CMDS()).sort()).toEqual(["listen.md", "unlisten.md", "wait.md"]); // no .bak files
      expect(readdirSync(CMDS()).map((f) => readFileSync(join(CMDS(), f), "utf8"))).toEqual(snap);
      expect(r2.stdout).not.toContain("Files changed");
      expect(r2.stdout).toContain("heartbeat.sh, linger.sh and hooks already up to date");
    });

    it("a pre-existing command file WITHOUT the marker is left alone with a warning; the other two are still installed", () => {
      writeTokens();
      mkdirSync(CMDS(), { recursive: true });
      writeFileSync(join(CMDS(), "wait.md"), "my own /wait command\n");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(CMDS(), "wait.md"), "utf8")).toBe("my own /wait command\n");
      expect(r.stderr).toMatch(/wait\.md/);
      expect(r.stderr).toMatch(/marker|not agency-board|left unchanged/i);
      expect(existsSync(join(CMDS(), "listen.md"))).toBe(true);
      expect(existsSync(join(CMDS(), "unlisten.md"))).toBe(true);
      expect(readdirSync(CMDS()).filter((f) => f.includes(".bak"))).toEqual([]);
    });

    it("a marked command file whose content differs is refreshed, with a backup of the old one", () => {
      writeTokens();
      mkdirSync(CMDS(), { recursive: true });
      writeFileSync(join(CMDS(), "listen.md"), `---\ndescription: old\n---\n${CMARK}\nold body\n`);
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(CMDS(), "listen.md"), "utf8")).toContain("linger.sh arm claude listen");
      const b = baks(CMDS(), "listen.md");
      expect(b).toHaveLength(1);
      expect(readFileSync(join(CMDS(), b[0]), "utf8")).toContain("old body");
    });

    it("full connect installs the commands too; --no-heartbeat does not", () => {
      const resp = join(dir, "resp.json");
      writeFileSync(resp, JSON.stringify({ server_url: `${STUB_BASE}/api/mcp`, machine: "m1", token_claude: FAKE_TOKEN }));
      writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(`file://${dir}`));
      expect(run(["ABCD2345", "--no-heartbeat"], { AGENCY_BOARD_TEST_RESPONSE_FILE: resp }).status).toBe(0);
      expect(existsSync(CMDS())).toBe(false);
      const r = run(["ABCD2345"], { AGENCY_BOARD_TEST_RESPONSE_FILE: resp });
      expect(r.status, r.stderr).toBe(0);
      expect(readdirSync(CMDS()).sort()).toEqual(["listen.md", "unlisten.md", "wait.md"]);
      const snap = readFileSync(join(CMDS(), "listen.md"), "utf8");
      expect(run(["ABCD2345"], { AGENCY_BOARD_TEST_RESPONSE_FILE: resp }).stdout).not.toMatch(/listen\.md/);
      expect(readFileSync(join(CMDS(), "listen.md"), "utf8")).toBe(snap);
    });

    it("the installed linger.sh is the new one (arm mode present) and parses", () => {
      writeTokens();
      run(["--", "--hooks-only"]);
      const l = readFileSync(join(AMD(), "linger.sh"), "utf8");
      expect(l).toContain("AGENCY_BOARD_LISTEN_UNIT");
      expect(spawnSync("/bin/sh", ["-n", join(AMD(), "linger.sh")]).status).toBe(0);
    });

    it("codex: with a codex token and ~/.codex, installs the skills (no shell command in them), NO prompts, the Interrupt and UserPromptSubmit hooks; rerun is a no-op; Stop 1900 upgraded", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      writeFileSync(CHJ(), JSON.stringify({ hooks: { Stop: [{ matcher: "", hooks: [{ type: "command", command: "sh ~/.agency-board/linger.sh stop codex", timeout: 1900 }] }] } }, null, 2) + "\n");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(CPROMPTS())).toBe(false); // /prompts:<name> is dead on Codex 0.162: no longer installed
      expect(readdirSync(CSKILLS()).sort()).toEqual(["listen", "unlisten", "wait"]);
      for (const name of ["listen", "wait", "unlisten"]) {
        const k = readFileSync(join(CSKILLS(), name, "SKILL.md"), "utf8");
        expect(k).toContain(CMARK);
        expect(k).not.toContain(dollarBrace);
        expect(k).not.toContain("linger.sh arm");
        expect(k).not.toContain("linger.sh disarm");
        expect(k).not.toMatch(/Run this command in your shell/);
        expect(k).toContain("UserPromptSubmit");
        expect(k).toContain('starts with "agency-board:"');
        expect(k).toMatch(/NEVER run a shell command/);
        expect(k).toMatch(/sandbox/);
        expect(k).toMatch(/\/hooks/);
        expect(k.split("\n")[0]).toBe("---");
        expect(k).toMatch(new RegExp(`^name: ${name}$`, "m"));
        expect(k).toMatch(/^description: .+/m);
      }
      // the skill may confirm ON/OFF only when the hook's exact line is in context; otherwise it must say NOT started + /hooks
      const sk = (n: string) => readFileSync(join(CSKILLS(), n, "SKILL.md"), "utf8");
      expect(sk("listen")).toContain(`"${HOOK_LINE_PREFIXES.listen}"`);
      expect(sk("listen")).toContain("listen mode did NOT start");
      expect(sk("wait")).toContain(`"${HOOK_LINE_PREFIXES.wait}"`);
      expect(sk("wait")).toContain("wait mode did NOT start");
      expect(sk("unlisten")).toContain(`"${HOOK_LINE_PREFIXES.unlisten}"`);
      expect(sk("unlisten")).toContain("was NOT turned off");
      for (const n of ["listen", "wait", "unlisten"]) {
        expect(sk(n), n).toMatch(/only if/i);
        expect(sk(n), n).toContain("/hooks");
      }
      const kl = readFileSync(join(CSKILLS(), "listen", "SKILL.md"), "utf8");
      expect(kl).toMatch(/list_tasks/);
      expect(kl).toMatch(/R2/);
      expect(readFileSync(join(CSKILLS(), "wait", "SKILL.md"), "utf8")).toMatch(/do NOT claim/i);
      const h = readJson(CHJ());
      expect(cmds(h, "Interrupt")).toEqual(["sh ~/.agency-board/linger.sh interrupt codex"]);
      expect(cmds(h, "UserPromptSubmit")).toEqual(["sh ~/.agency-board/linger.sh prompt codex"]);
      expect(stopTimeouts(h)).toEqual([86400]);
      const snapH = readFileSync(CHJ(), "utf8");
      const snapK = ["listen", "wait", "unlisten"].map((n) => readFileSync(join(CSKILLS(), n, "SKILL.md"), "utf8"));
      const r2 = run(["--", "--hooks-only"]);
      expect(r2.status, r2.stderr).toBe(0);
      expect(readFileSync(CHJ(), "utf8")).toBe(snapH);
      expect(["listen", "wait", "unlisten"].map((n) => readFileSync(join(CSKILLS(), n, "SKILL.md"), "utf8"))).toEqual(snapK);
      expect(existsSync(CPROMPTS())).toBe(false);
      expect(readdirSync(join(CSKILLS(), "listen"))).toEqual(["SKILL.md"]);
      expect(r2.stdout).not.toMatch(/trust/i);
    });

    it("codex: the claude command files are byte-identical to before (still the bang arm line, not the hook text)", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      run(["--", "--hooks-only"]);
      const c = readFileSync(join(CMDS(), "listen.md"), "utf8");
      expect(c).toContain(bang(`sh ~/.agency-board/linger.sh arm claude listen "${dollarBrace}"`));
      expect(c).not.toContain("UserPromptSubmit");
    });

    it("codex: an existing user UserPromptSubmit hook is kept; ours is appended once", () => {
      writeTokens(true);
      mkdirSync(join(home, ".codex"));
      writeFileSync(CHJ(), JSON.stringify({ hooks: { UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 2) + "\n");
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      expect(run(["--", "--hooks-only"]).status).toBe(0);
      expect(cmds(readJson(CHJ()), "UserPromptSubmit")).toEqual(["echo mine", "sh ~/.agency-board/linger.sh prompt codex"]);
    });

    it("codex upgrade: a marked ~/.codex/prompts/{listen,wait,unlisten}.md from an older connect is moved aside to a .bak-agency-board-<ts> (listed under Backups), never re-created; a rerun is a no-op", () => {
      writeTokens(true);
      mkdirSync(CPROMPTS(), { recursive: true });
      for (const n of ["listen", "wait", "unlisten"]) writeFileSync(join(CPROMPTS(), `${n}.md`), `---\ndescription: old ${n}\n---\n${CMARK}\nRun sh ~/.agency-board/linger.sh arm codex ${n}\n`);
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      const left = readdirSync(CPROMPTS()).sort();
      expect(left.filter((f) => !f.includes(".bak-agency-board-"))).toEqual([]); // the live prompt files are gone
      expect(left).toHaveLength(3);
      for (const n of ["listen", "wait", "unlisten"]) {
        const b = baks(CPROMPTS(), `${n}.md`);
        expect(b, n).toHaveLength(1);
        expect(readFileSync(join(CPROMPTS(), b[0]), "utf8")).toContain(`arm codex ${n}`); // content preserved
        expect(r.stdout).toContain(b[0]); // reported under Backups
      }
      const r2 = run(["--", "--hooks-only"]);
      expect(r2.status, r2.stderr).toBe(0);
      expect(readdirSync(CPROMPTS()).sort()).toEqual(left);
    });

    it("codex: a pre-existing NON-marker prompt is the user's: untouched, no warning, no backup; a non-marker skill is left alone with a warning", () => {
      writeTokens(true);
      mkdirSync(CPROMPTS(), { recursive: true });
      mkdirSync(join(CSKILLS(), "wait"), { recursive: true });
      writeFileSync(join(CPROMPTS(), "listen.md"), "mine\n");
      writeFileSync(join(CSKILLS(), "wait", "SKILL.md"), "mine too\n");
      const r = run(["--", "--hooks-only"]);
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(CPROMPTS(), "listen.md"), "utf8")).toBe("mine\n");
      expect(readdirSync(CPROMPTS())).toEqual(["listen.md"]); // no backup, no other prompt installed
      expect(readFileSync(join(CSKILLS(), "wait", "SKILL.md"), "utf8")).toBe("mine too\n");
      expect(r.stderr).not.toMatch(/prompts/);
      expect(r.stderr).toMatch(/SKILL\.md/);
      expect(existsSync(join(CSKILLS(), "listen", "SKILL.md"))).toBe(true);
    });

    it("codex: no codex token or no ~/.codex means no prompts, no skills, no ~/.agents, no Interrupt hook", () => {
      writeTokens(true);
      run(["--", "--hooks-only"]); // codex token, but no ~/.codex dir
      expect(existsSync(CPROMPTS())).toBe(false);
      expect(existsSync(join(home, ".agents"))).toBe(false);
      mkdirSync(join(home, ".codex"), { recursive: true }); // the guide step already created it
      rmSync(join(AMD(), "codex.token"));
      run(["--", "--hooks-only"]); // ~/.codex but no token
      expect(existsSync(CPROMPTS())).toBe(false);
      expect(existsSync(join(home, ".agents"))).toBe(false);
      expect(existsSync(CHJ())).toBe(false);
    });
  });

  it("--no-heartbeat skips every hook, linger included", () => {
    const resp = join(dir, "resp.json");
    writeFileSync(resp, JSON.stringify({ server_url: `${STUB_BASE}/api/mcp`, machine: "m1", token_claude: FAKE_TOKEN }));
    writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(`file://${dir}`));
    const r = run(["ABCD2345", "--no-heartbeat"], { AGENCY_BOARD_TEST_RESPONSE_FILE: resp });
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(join(AMD(), "linger.sh"))).toBe(false);
    expect(existsSync(SJ())).toBe(false);
  });
});

// SECURITY: the bearer token must never appear in any process argv (any local user can read `ps`). Generated shell
// scripts hand it to curl as a config line on stdin (`curl -K -`, printed by the printf builtin).
describe("bearer token never in a process argv", () => {
  const SRC: Array<[string, string]> = [["connect.sh", CONNECT_SH], ["linger.sh", LINGER_SH], ["connect.ps1", CONNECT_PS1]];
  // The ONE documented exception: `claude mcp add --header` has no env/stdin form (docs/connect.md "Known limit").
  const ALLOWED = /claude mcp add/;

  it.each(SRC)("static: %s has no curl line or other argv carrying 'Bearer'/'Authorization' with a token variable", (_n, src) => {
    const bad = src.split("\n").filter((l) => /\bcurl\b[^\n]*(Bearer|Authorization)/.test(l) && !/^\s*(#|echo|warn|say)/.test(l));
    expect(bad).toEqual([]);
    const argvBearer = src.split("\n").filter((l) => /Bearer (\$|"?\s*\+|\$\()/.test(l) && !ALLOWED.test(l) && !/Invoke-WebRequest|\$auth = @\{/.test(l));
    expect(argvBearer).toEqual([]);
  });

  it("static: no external command gets a token as an argument (awk -v / tok in argv), except the documented claude mcp add", () => {
    const bad = CONNECT_SH.split("\n").filter((l) => /\$\(tok /.test(l) && !ALLOWED.test(l) && !/^\s*(#|say|warn|echo)/.test(l) && !/cut -c1-12/.test(l));
    expect(bad.map((l) => l.trim())).toEqual(['AGENCY_BOARD_V="AGENCY_BOARD_TOKEN_HERMES=$(tok hermes)" awk \'']); // env var, not argv
    expect(CONNECT_SH).not.toMatch(/awk -v [^\n]*\$\(tok /); // (tokpfx passes only the literal name prefix)
  });

  it("static: every curl invocation that sends the token uses the -K - config", () => {
    const authLines = CONNECT_SH.split("\n").filter((l) => /ab_auth/.test(l) && /\bcurl\b/.test(l));
    expect(authLines.length).toBeGreaterThanOrEqual(5); // heartbeat POST, inbox, guide, linger x3 (spliced in)
    for (const l of authLines) expect(l).toMatch(/\| curl [^\n]*-K - /);
  });

  describe("dynamic: fake curl records argv and stdin", () => {
    let dir: string;
    let home: string;
    let bin: string;
    let script: string;
    const SECRET = "agency-board_claude_SECRETSECRETSECRET0123456789_-abcdefghi";
    const argvLog = () => (existsSync(join(dir, "argv.log")) ? readFileSync(join(dir, "argv.log"), "utf8") : "");
    const stdinLog = () => (existsSync(join(dir, "stdin.log")) ? readFileSync(join(dir, "stdin.log"), "utf8") : "");
    const env = () => ({ HOME: home, PATH: `${bin}:/usr/bin:/bin` }) as unknown as NodeJS.ProcessEnv;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ab-tokargv-"));
      home = join(dir, "home");
      bin = join(dir, "bin");
      mkdirSync(join(home, ".agency-board"), { recursive: true });
      mkdirSync(bin);
      writeFileSync(join(home, ".agency-board", "claude.token"), SECRET + "\n", { mode: 0o600 });
      script = join(dir, "connect.sh");
      writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(STUB_BASE));
      const f = join(bin, "curl");
      writeFileSync(
        f,
        [
          "#!/bin/sh",
          `D="${dir}"`,
          'printf "%s\\n" "$*" >> "$D/argv.log"',
          'case " $* " in *" -K - "*) cat >> "$D/stdin.log" ;; esac',
          'out=""; prev=""; for a in "$@"; do if [ "$prev" = -o ]; then out="$a"; fi; prev="$a"; done',
          'case "$*" in *inbox*) echo "agency-board: no pending tasks" ;; esac',
          '[ -z "$out" ] || echo "GUIDE" > "$out"',
          "exit 0",
          "",
        ].join("\n"),
      );
      chmodSync(f, 0o755);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("connect.sh --hooks-only (guide fetch) and the installed heartbeat.sh (session-start + stop)", () => {
      const r = spawnSync("/bin/sh", ["-s", "--", "--hooks-only"], { input: readFileSync(script, "utf8"), env: env(), encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      expect(readFileSync(join(home, ".agency-board", "guide.txt"), "utf8")).toBe("GUIDE\n"); // -o target still written
      const hb = join(home, ".agency-board", "heartbeat.sh");
      const start = spawnSync("/bin/sh", [hb, "session-start"], { env: env(), encoding: "utf8" });
      expect(start.status).toBe(0);
      expect(start.stdout).toContain("agency-board: no pending tasks"); // inbox body still printed
      expect(start.stderr).toBe("");
      const stop = spawnSync("/bin/sh", [hb, "stop"], { env: env(), encoding: "utf8" });
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe("");
      const argv = argvLog();
      expect(argv).toContain("/api/v1/heartbeat");
      expect(argv).toContain("/api/v1/inbox");
      expect(argv).toContain("/api/v1/guide");
      expect(argv).not.toContain(SECRET);
      expect(argv).not.toMatch(/Bearer|Authorization/);
      // guide + heartbeat + inbox + heartbeat(stop) = 4 authenticated calls, each with the header on stdin
      expect(stdinLog().split(`header = "Authorization: Bearer ${SECRET}"`).length - 1).toBe(4);
    });

    it("heartbeat.sh with an unsafe token (quote / backslash): exits 0, silent, sends no Authorization at all", () => {
      const r0 = spawnSync("/bin/sh", ["-s", "--", "--hooks-only"], { input: readFileSync(script, "utf8"), env: env(), encoding: "utf8" });
      expect(r0.status, r0.stderr).toBe(0);
      const hb = join(home, ".agency-board", "heartbeat.sh");
      for (const bad of ['agency-board_x"y', "agency-board_x\\y"]) {
        rmSync(join(dir, "stdin.log"), { force: true });
        rmSync(join(dir, "argv.log"), { force: true });
        writeFileSync(join(home, ".agency-board", "claude.token"), bad + "\n");
        const r = spawnSync("/bin/sh", [hb, "session-start"], { env: env(), encoding: "utf8" });
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
        expect(stdinLog()).not.toMatch(/Bearer|Authorization/);
        expect(argvLog()).not.toContain(bad.slice("agency-board_".length));
      }
    });
  });
});

// SECURITY (regression guard): NO generated script may put a bearer token in a curl argv. Every exported script constant of
// lib/scripts/* is scanned, so a newly added generated script is covered without editing this test. The only allowlisted
// exception is the documented `claude mcp add --header` (docs/connect.md "Known limit").
describe("no generated script puts a bearer token in a curl argv", () => {
  const MODS: Record<string, Record<string, unknown>> = { connectSh: connectShMod, connectPs1: connectPs1Mod, lingerSh: lingerShMod, workerMjs: workerMjsMod };
  const SCRIPTS: Array<[string, string]> = [];
  for (const [mod, ns] of Object.entries(MODS)) for (const [name, v] of Object.entries(ns)) if (typeof v === "string" && v.length > 500) SCRIPTS.push([`${mod}.${name}`, v]);
  const ALLOWED = /claude mcp add/;
  /** Logical lines (backslash-newline joined) that hand a bearer to a curl via -H / --header. */
  function bearerInCurlArgv(src: string): string[] {
    return src
      .replace(/\\\n/g, " ")
      .split("\n")
      .filter((l) => !ALLOWED.test(l))
      .filter((l) => /(-H|--header)[ =]+["']?Authorization:\s*Bearer/i.test(l) || (/\bcurl\b/.test(l) && /Authorization:\s*Bearer\s*["']?\s*\$/.test(l) && !/^\s*#/.test(l)));
  }

  it("covers every generated script constant (guards against the collector silently finding nothing)", () => {
    const names = SCRIPTS.map(([n]) => n);
    for (const n of ["connectSh.CONNECT_SH", "connectPs1.CONNECT_PS1", "lingerSh.LINGER_SH", "workerMjs.WORKER_MJS"]) expect(names).toContain(n);
  });

  it("the detector flags `-H \"Authorization: Bearer $T\"` and `${T}` forms, and ignores the documented claude mcp add", () => {
    expect(bearerInCurlArgv('curl -fsS -H "Authorization: Bearer $T" "$B"')).toHaveLength(1);
    expect(bearerInCurlArgv('curl -fsS -H "Authorization: Bearer ${T}" "$B"')).toHaveLength(1);
    expect(bearerInCurlArgv("curl -fsS \\\n  -H 'Authorization: Bearer '\"$T\" \"$B\"")).toHaveLength(1);
    expect(bearerInCurlArgv('claude mcp add x "$U" --header "Authorization: Bearer $(tok claude)"')).toHaveLength(0);
    expect(bearerInCurlArgv("printf 'header = \"Authorization: Bearer %s\"\\n' \"$1\" | curl -K - \"$B\"")).toHaveLength(0);
  });

  it.each(SCRIPTS)("%s: no bearer in any curl argv", (_n, src) => {
    expect(bearerInCurlArgv(src)).toEqual([]);
  });

  it("every script connect.sh actually installs into ~/.agency-board is clean too (heartbeat, linger, and any future codex hook file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ab-scanall-"));
    try {
      const home = join(dir, "home");
      const bin = join(dir, "bin");
      mkdirSync(join(home, ".agency-board"), { recursive: true });
      mkdirSync(join(home, ".codex"));
      mkdirSync(bin);
      writeFileSync(join(home, ".agency-board", "claude.token"), FAKE_TOKEN + "\n", { mode: 0o600 });
      writeFileSync(join(home, ".agency-board", "codex.token"), "agency-board_codex_testtoken00000000000\n", { mode: 0o600 });
      for (const n of ["curl", "claude", "codex"]) { writeFileSync(join(bin, n), "#!/bin/sh\nexit 7\n"); chmodSync(join(bin, n), 0o755); }
      const script = join(dir, "connect.sh");
      writeFileSync(script, CONNECT_SH.split("__AGENCY_BOARD_BASE_URL__").join(STUB_BASE));
      const r = spawnSync("/bin/sh", ["-s", "--", "--hooks-only"], { input: readFileSync(script, "utf8"), env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv, encoding: "utf8" });
      expect(r.status, r.stderr).toBe(0);
      const installed = readdirSync(join(home, ".agency-board")).filter((f) => /\.(sh|mjs|js|ps1)$/.test(f) && !f.includes(".bak-"));
      expect(installed).toEqual(expect.arrayContaining(["heartbeat.sh", "linger.sh"]));
      for (const f of installed) expect(bearerInCurlArgv(readFileSync(join(home, ".agency-board", f), "utf8")), f).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
