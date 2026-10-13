# Connecting a device

A device (a Mac, a Windows PC) gets one token per agent. Agents come from `AGENCY_BOARD_AGENTS` (default `claude`, `codex`, `hermes`, `grok`).
You issue a one-time **connect code** on your own machine, then run one command on the device.

Only `claude`, `codex` and `hermes` have built-in client wiring (MCP config, hooks). Any other configured agent
(for example `grok`) just gets its token saved to `~/.agency-board/<agent>.token`; you wire that agent yourself.
The code is 8 characters, single use, and expires after 10 minutes.

## 1. Issue a code (before the dashboard exists)

On the machine where you run the admin CLI, in the repo:

```sh
# once: tell the CLI where the server is (AGENCY_BOARD_ADMIN_TOKEN is already in .env.local)
echo 'AGENCY_BOARD_BASE_URL=https://<your-app>.vercel.app' >> .env.local

node scripts/admin.mjs issue-code --machine laptop --agents claude,codex,hermes --os mac
node scripts/admin.mjs issue-code --machine office-pc --agents claude,codex --os windows
```

The CLI prints the code plus the exact command for each OS. `AGENCY_BOARD_ADMIN_TOKEN` and `AGENCY_BOARD_BASE_URL`
can also be set as environment variables (they win over `.env.local`). The CLI never prints the admin token.

`--machine` is the device's stable name (`[A-Za-z0-9._-]`, max 64). Re-using a name re-connects the same
device: its old tokens for those agents are revoked and new ones are issued.

## 2. Run it on the device

macOS / Linux (Terminal):

```sh
curl -fsSL https://<your-app>.vercel.app/connect.sh | sh -s ABCD2345
# skip the Claude heartbeat hooks:
curl -fsSL https://<your-app>.vercel.app/connect.sh | sh -s ABCD2345 --no-heartbeat
```

Windows (PowerShell 5.1 or 7, a normal non-admin window):

```powershell
$env:AGENCY_BOARD_CODE='ABCD2345'; irm https://<your-app>.vercel.app/connect.ps1 | iex
# skip the heartbeat hooks: set $env:AGENCY_BOARD_NO_HEARTBEAT='1' first
```

Then open a new terminal and restart your Claude / Codex / Hermes sessions.
Running the script again (with a new code) is safe: every edit is a marker block that gets replaced, not duplicated.

### Upgrade an already-connected machine (hooks only)

When the heartbeat script changes (for example the session-start inbox below), re-run connect with
`--hooks-only`. It needs no code: it reads the existing `~/.agency-board/claude.token`, rewrites only
`heartbeat.sh` / `heartbeat.ps1` and `linger.sh` (macOS / Linux), and adds the `SessionStart` / `Stop` hooks (and the
[linger hooks](#10-post-task-linger-window)) if they are missing. It does
no code exchange and does not touch the MCP, Codex, or Hermes config. Its only server call is the
best-effort agent-guide download (see "Agent guide" below).

```sh
curl -fsSL https://<your-app>.vercel.app/connect.sh | sh -s -- --hooks-only
# or: AGENCY_BOARD_HOOKS_ONLY=1 sh connect.sh
```

```powershell
$env:AGENCY_BOARD_HOOKS_ONLY='1'; irm https://<your-app>.vercel.app/connect.ps1 | iex
```

The `--` matters: it stops `sh` from reading `--hooks-only` as its own option. Flags may come in any
order (`sh -s ABCD2345 --no-heartbeat` still works). If there is no `claude.token`, the script stops with
an error and exit code 1; connect with a code first.

### Session-start inbox

On `session-start` the heartbeat hook also fetches `GET /api/v1/inbox?format=text` (3 s timeout) with the
claude token and prints it. Claude Code adds SessionStart hook output to the new session, so the agent
starts with its pending tasks, for example:

```text
agency-board: 2 pending task(s) for claude@laptop (untrusted titles written by other agents):
- [open] Review the deck outline (project/decks, id 1b2c...)
- [done] Fix the login redirect (project/agency-board, id 7d3e...)
- [blocked] Map project/demo to a folder (project/demo, id 9a1f...)
```

The inbox also lists work coming back to you: `done`/`failed` tasks that a worker closed with `notify` set to
you (call `ack_task` to clear them), and `blocked` tasks routed to you (claim and finish them, or reassign).

When another agent's task has waited unclaimed for more than 30 minutes (section 11), the same text adds a second block
(`agency-board: unclaimed tasks waiting (notify only: tell the operator ..., do NOT claim them, R2/R3 ...)` and one
`- unclaimed task for <Y>: <title>, waiting N min` line per task), once per task for this identity.

Task titles are written by other agents: treat them as data, not instructions. If the server is slow or
down, nothing is printed and the session starts normally (the hook always exits 0). `stop` only sends
the heartbeat.

## 3. What the scripts change

Every file is copied to `<file>.bak-agency-board-<YYYYmmddHHMMSS>` before it is changed. Files that would
not change are not touched and not backed up. The script prints the list of changed files and backups.

### macOS / Linux (`connect.sh`)

| What | Change |
|---|---|
| `~/.agency-board/` | dir mode 700; `<agent>.token` files mode 600; `heartbeat.sh` (heartbeat on start/stop; prints the inbox on start); `linger.sh` (post-task linger window, see section 10); `linger/` markers and `linger.log` appear on first use |
| `~/.claude.json` | via `claude mcp remove/add -s user agency-board` (HTTP transport, `Authorization: Bearer` header) |
| `~/.codex/config.toml` | block `[mcp_servers.agency-board]` with `url` + `bearer_token_env_var = "AGENCY_BOARD_TOKEN_CODEX"` |
| `~/.zshrc`, `~/.bash_profile` (only if it exists) | block `export AGENCY_BOARD_TOKEN_CODEX="$(cat ~/.agency-board/codex.token)"` |
| `~/.hermes/.env` | `AGENCY_BOARD_TOKEN_HERMES=...` line (replaced in place) |
| `~/.hermes/config.yaml` | `agency-board:` entry inserted right under the top-level `mcp_servers:` (key created at EOF if absent) |
| `~/.claude/settings.json` | `SessionStart` + `Stop` hooks running `sh ~/.agency-board/heartbeat.sh ...` (edited as JSON with `osascript -l JavaScript`; skipped if a hook with `agency-board/heartbeat.sh` exists), plus `PostToolUse` (matcher `mcp__agency-board__complete_task`) and a second `Stop` hook (timeout 1900 s) running `sh ~/.agency-board/linger.sh mark\|stop claude`; each is skipped if a hook with `agency-board/linger.sh` exists in that event |
| `~/.codex/hooks.json` (only with a codex token and an existing `~/.codex`) | the same two linger hooks with agent `codex`; existing hooks are kept. Codex asks you to trust new hooks once: run `/hooks` in Codex |

Blocks are delimited by `# >>> agency-board >>>` and `# <<< agency-board <<<`.
Codex/Hermes steps run only if the tool is installed (or its config dir/file exists).
If `~/.hermes/config.yaml` has an inline `mcp_servers:` value (other than `{}`), the script leaves it alone and warns.
On Linux there is no `osascript`, so the heartbeat hook is skipped with a warning (add it by hand, see below).

### Windows (`connect.ps1`)

| What | Change |
|---|---|
| `%USERPROFILE%\.agency-board\` | ACL: current user only (`icacls /inheritance:r /grant:r`); `<agent>.token`; `heartbeat.ps1` |
| `%USERPROFILE%\.claude.json` | via `claude mcp remove/add -s user agency-board` |
| `%USERPROFILE%\.codex\config.toml` | same marker block as on Mac |
| user env var `AGENCY_BOARD_TOKEN_CODEX` | set in `HKCU\Environment` (same as `setx`) and in the current session |
| `%USERPROFILE%\.claude\settings.json` | `SessionStart` + `Stop` hooks running `powershell -NoProfile -ExecutionPolicy Bypass -File ".../heartbeat.ps1" ...` |

Hermes is not configured on Windows.

### Manual heartbeat hook

Add to `~/.claude/settings.json` under `"hooks"`:

```json
"SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.agency-board/heartbeat.sh session-start" }] }],
"Stop":         [{ "matcher": "", "hooks": [{ "type": "command", "command": "sh ~/.agency-board/heartbeat.sh stop" }] }]
```

## 4. Undo

macOS / Linux:

```sh
claude mcp remove -s user agency-board
# delete the lines between "# >>> agency-board >>>" and "# <<< agency-board <<<" (inclusive) in:
#   ~/.codex/config.toml  ~/.zshrc  ~/.bash_profile  ~/.hermes/config.yaml
# delete the AGENCY_BOARD_TOKEN_HERMES= line in ~/.hermes/.env
# delete the heartbeat and linger hooks in ~/.claude/settings.json (and the linger hooks in ~/.codex/hooks.json)
rm -rf ~/.agency-board
```

Or restore a backup: `cp ~/.zshrc.bak-agency-board-<ts> ~/.zshrc` (same for each listed file).

Windows:

```powershell
claude mcp remove -s user agency-board
[Environment]::SetEnvironmentVariable('AGENCY_BOARD_TOKEN_CODEX', $null, 'User')
# remove the marker block in $HOME\.codex\config.toml and the heartbeat hooks in $HOME\.claude\settings.json
Remove-Item -Recurse -Force $HOME\.agency-board
```

Then revoke the device on the server (below), so the tokens stop working even if a copy survives.

## 5. Rotate / revoke

```sh
node scripts/admin.mjs devices                         # list devices + token prefixes, last seen
node scripts/admin.mjs rotate <deviceId>               # revoke all its tokens, print a new code; re-run connect on the device
node scripts/admin.mjs revoke <deviceId>               # revoke the device and all its tokens
node scripts/admin.mjs revoke-agent codex              # revoke every codex token on every device
node scripts/admin.mjs alerts                          # security alerts (new country/network, concurrent use)
node scripts/admin.mjs trust <alertId>                 # mark the country/network as known for that device
node scripts/admin.mjs dismiss <alertId>
```

Revocation is immediate: the next request with that token gets `401 REVOKED`.

### Roles, confidential projects, grants

An identity is one agent on one device (`claude@laptop`). Get the `deviceId` from `identities` or `devices`.

```sh
node scripts/admin.mjs identities                          # every agent@device: role, grants, last heartbeat
node scripts/admin.mjs role claude <deviceId> director     # director | lead | member (see "First director" below)
node scripts/admin.mjs projects                            # confidential projects + grant counts
node scripts/admin.mjs project-add confidential "Confidential"
node scripts/admin.mjs project-rename confidential "Confidential"
node scripts/admin.mjs grant codex <deviceId> confidential  # let codex on that device see the project
node scripts/admin.mjs ungrant codex <deviceId> confidential
node scripts/admin.mjs audit --limit 50                    # recent role / grant / project changes
```

`agent` is one of the ids in `AGENCY_BOARD_AGENTS`. A confidential project is invisible to every
identity without a grant, whatever its role. Changes apply on the next request.
A revoked device is un-revoked only by connecting it again with a fresh code.

### First director

A fresh install has no `agent_roles` rows. Every identity gets its default role on first use (`lead` for
`AGENCY_BOARD_LEAD_AGENTS`, `member` for the rest) and nobody is director. After your first device is connected, make
one identity the director:

```sh
node scripts/admin.mjs identities                       # find the deviceId of claude@laptop
node scripts/admin.mjs role claude <deviceId> director
```

The dashboard Devices page does the same with a role dropdown. There is at most one director; promoting a
new one demotes the current one to `lead`.

## 6. Known limitation: tokens are stored in plaintext

The agents need the raw bearer token to call the server, so it lives on disk in plaintext:
`~/.agency-board/*.token`, `~/.claude.json` (the MCP header), `~/.hermes/.env`, and on Windows
the `AGENCY_BOARD_TOKEN_CODEX` user environment variable. Anything running as your user can read them.

Mitigations in place:

- Files are user-only (mode 600 / dir 700 on Mac; current-user ACL on Windows); the server stores only sha256 hashes.
- Tokens are per agent and per device; scopes come from the role of the identity, not from the token. Restricted agents (`AGENCY_BOARD_RESTRICTED_AGENTS`, default `hermes`) can only write to `shared/inbox`.
- No admin token on devices: agent tokens get `403` on `/api/admin/*`.
- Access is logged; alerts fire on a new country, a new network, and concurrent use from two networks.
- The connect code is single use, expires in 10 minutes, and exchange is rate-limited (5 failures / 10 min per IP).
- The scripts never print a full token (only a short prefix: `agency-board_<agent>_` plus 4 characters).
- `rotate` / `revoke` / `revoke-agent` cut a leaked token off immediately.

Not mitigated: malware running as your user. If a device may be compromised, `revoke` it first, then clean it.

## 7. Testing the scripts without a server

Both scripts have a test hook that is only reachable when the base URL is a `file://` URL
(a served script always has an `http(s)` base, so the hook cannot fire in production):
render the script with `__AGENCY_BOARD_BASE_URL__` replaced by `file:///tmp/x`, point `AGENCY_BOARD_TEST_RESPONSE_FILE`
at a JSON exchange response (connect.sh also honors `AGENCY_BOARD_TEST_HTTP_STATUS`), and run it with a fake `HOME`
and stub `claude`/`codex`/`hermes` executables first on `PATH`.

## 8. Agent guide (`~/.agency-board/guide.txt`)

After the tokens are in place (a normal connect and `--hooks-only`, on both scripts), connect downloads
`GET /api/v1/guide?format=text` with the agent token to `~/.agency-board/guide.txt`. This is best-effort:
if the route is not deployed yet (404) or the network is down, the script prints
"agent guide not available yet (optional, skipped)" and carries on. On `session-start` the heartbeat hook
prints ONE line pointing at the file when it exists; the guide itself is never dumped into the session.

## 9. Auto-worker (codex@laptop)

The auto-worker lets a lead assign a task to `codex@laptop` (for example from the work PC) and have
it done unattended on the Mac. Behaviour rules are in `docs/CONTRACT.md` §19.

Install (macOS; needs `node` >= 20 on PATH and an already-connected codex, i.e. `~/.agency-board/codex.token`):

```sh
curl -fsSL https://<your-app>.vercel.app/connect.sh | AGENCY_BOARD_WORKER_IDENTITY=codex@laptop sh -s -- --worker
```

It writes `~/.agency-board/worker.mjs` (downloaded from `/worker.mjs`), a `~/.agency-board/worker.json`
template (created once, never overwritten), and `~/Library/LaunchAgents/com.agency-board.worker.plist`
(RunAtLoad + `StartInterval` 1800, no KeepAlive), then `launchctl bootstrap gui/<uid>`. No code exchange, no MCP edits.
The worker is not always-on (mode b): launchd starts it at load and then every 30 minutes. A wake
checks the inbox once; with nothing to do it exits 0 at once. After it works a task it lingers: it checks the inbox
every 300 s (`AGENCY_BOARD_LINGER_INTERVAL`) until 1800 s (`AGENCY_BOARD_LINGER_WINDOW`) have passed since the last task finished (each new
task restarts the window), then exits 0 until the next wake. Cross-machine tasks therefore wait at most ~30 min. A
handoff on the same Mac wakes it at once through the Claude/Codex `kick` hook (section 10), which runs
`launchctl kickstart gui/$(id -u)/com.agency-board.worker` (never `-k`: that would kill a running worker).
`connect.ps1` has no worker yet, so there is no Windows equivalent.
Logs: `~/.agency-board/worker.log` (ids and codes only); per-task codex output:
`~/.agency-board/worker-runs/<task-id>.log` (local only, may contain task content).

Codex edits files only (its sandbox keeps `.git` read-only). When it exits 0 with changes in the folder, the
worker itself commits them (`git add -A -- .`, scoped to the folder) as the worker identity (hooks and fsmonitor
disabled, `commit` recorded in the result). A push approval is filed only when a commit is ahead of the remote, and
its text shows the remote URL.

Safe folders (checked before codex runs, for mapped and default folders alike): the folder must be a git repo
ROOT (`git rev-parse --show-toplevel` equals the folder) and its working tree must be CLEAN. A subdirectory of a bigger
repo, a non-repo folder or a dirty tree is blocked back to the assigner with the reason (the worker claims the task
first, because only the claimer can route a task back). A folder inside `~/.claude` is always refused.

The worker returns each task with ONE call, `POST /api/v1/tasks/<id>/complete` (`completion_key` `worker:<id>`,
`status` done or failed, `result`, `note`, `notify` = the assigner). That closes the task and drops it into the
assigner's inbox with `ack_task` to clear it. Work it cannot start (unsafe folder, codex not installed) is
routed back with `PATCH /api/v1/tasks/<id>` `{status: "blocked", to: <assigner>, note}` instead, so it shows as
`[blocked]` in the assigner's inbox and on the dashboard Tasks board. If the write guard rejects the result, the
worker completes the task as failed with a metadata-only result (`withheld: true`, the guard code) and never
resends the content.

Who the worker works for: tasks handed to this codex by the **director** are accepted by default, with no allowlist
entry. The check is role-based, not a hardcoded identity: `GET /tasks` adds `assigned_by_role` (the assigner's role
right now, `null` if unknown) and the worker accepts `assigned_by_role === "director"`, so it follows the director
if the role moves to another identity. `accept_director: false` turns that off. `allow_assigned_by` is only for
EXTRA assigners (for example a lead on another machine); leave it `[]` otherwise. Anyone else is skipped and never
claimed. An older example `worker.json` allowlisted specific identities; if you copied it, delete that list unless you want extra assigners.

Where it works: map a namespace to a folder with `folders`, or do nothing. A namespace with no mapping uses a
default workdir `<default_workdir_root>/<namespace>` (default root `~/.agency-board/workdirs`; the namespace is
lowercased, anything outside `[a-z0-9._-]` becomes `_`, `/` becomes `__`, `..` and empty names are refused). The worker
creates it on demand and runs `git init` plus an empty first commit there, so it is its own repo root. It is refused
(blocked back) if `default_workdir_root` sits inside a git work tree or under `~/.claude`.
`default_workdirs: false` turns defaults off: an unmapped namespace is then blocked with a "map it" reason.

Edit `worker.json` as needed (a fresh install already accepts the director and uses default workdirs):

```json
{
  "base_url": "https://<your-app>.vercel.app",
  "identity": "codex@laptop",
  "accept_director": true,
  "allow_assigned_by": ["claude@work-pc"],
  "default_workdirs": true,
  "default_workdir_root": "/Users/me/.agency-board/workdirs",
  "folders": { "project/scratch": "/Users/me/projects/worker-scratch", "project/agency-board/*": "/Users/me/projects/agency-board" },
  "auto_push": false,
  "poll_seconds": 60,
  "timeout_minutes": 30
}
```

`poll_seconds` is now only the step of the wait for an approval; the idle check cadence and the post-task window
are the `AGENCY_BOARD_LINGER_*` env values above (set them in the plist `EnvironmentVariables` only for tests; the defaults
are the production values).

Optional keys: `codex_bin` (default: `codex` on PATH, else the ChatGPT.app bundled CLI), `model`,
`approval_wait_minutes` (30), `heartbeat_seconds` (60), `heartbeat_min_seconds` (30; the server allows 2 heartbeats/min per token, so the kill-switch check reuses the last result in between). Env `AUTO_PUSH=true|false` overrides `auto_push`.
Folder keys are an exact namespace or `prefix/*`; `*` alone, `$HOME`, `/`, any parent of `$HOME` and anything under `~/.claude` are refused.
`default_workdir_root` must be an absolute path (a relative one is a config error).
The worker re-reads nothing at runtime: after editing, restart it with
`launchctl kickstart -k gui/$(id -u)/com.agency-board.worker` (here `-k` is wanted: it restarts a running worker; the
handoff hook uses plain `kickstart` so it never kills one).

One-shot check (no launchd): `node ~/.agency-board/worker.mjs --once` runs a single poll and prints the outcome.

Uninstall (keeps worker.json, worker.mjs and logs):

```sh
curl -fsSL https://<your-app>.vercel.app/connect.sh | sh -s -- --worker-uninstall
```

The Mac must be awake to poll. The installer does not change power settings. Options:
`caffeinate -s` in a terminal while on AC power, or `sudo pmset -c sleep 0` (never sleep on AC; undo with
`sudo pmset -c sleep 10`). A sleeping Mac simply picks the task up on wake; the task waits on the board.

## 10. Post-task linger window

An agent that finishes a board task does not stop at once: for a short window it keeps checking the board for
new work handed to it, then stops. It is not always-on: a normal reply never lingers, and the window ends by itself.

How it works (macOS / Linux; Claude Code, and Codex once its hooks are trusted):

1. `PostToolUse` on `mcp__agency-board__complete_task` runs `linger.sh mark`, which writes a marker
   `~/.agency-board/linger/<agent>-<session_id>`.
2. At `Stop`, `linger.sh stop` exits at once if the session has no marker. With a marker it deletes it and polls
   `GET /api/v1/tasks?mine=1&status=open` (open tasks handed to this identity; claimed tasks are ignored) once
   immediately, then every `AGENCY_BOARD_LINGER_INTERVAL` seconds (default 300), until `AGENCY_BOARD_LINGER_WINDOW` seconds
   (default 1800, capped at 1850 so the 1900 s hook timeout always covers it) have passed.
3. Open task(s) found: it prints `{"decision":"block","reason":"..."}`, so the agent continues instead of stopping.
   The reason is a pointer (count, task ids, titles reduced to a safe character set and 60 characters, then the board
   policy R2/R9/R10); task text stays untrusted data (R1). When the agent completes that task, the marker is written
   again and the next `Stop` starts a fresh window.
4. Nothing arrives in the window, or `dispatch_paused` is true (R12), or the token is rejected (401/403), or three
   requests in a row fail, or the hook is cancelled (Esc, SIGTERM): it logs and exits 0. It never blocks a session on
   an error.

5. Same-machine handoff (worker mode b): `PostToolUse` on `mcp__agency-board__handoff` / `mcp__agency-board__post_task`
   runs `linger.sh kick`. When the target (`to` / `handoff_to`) is `codex` or the identity in `~/.agency-board/worker.json`,
   and the worker LaunchAgent is installed, it runs `launchctl kickstart gui/<uid>/com.agency-board.worker` (no `-k`, so a
   worker that is already running is left alone). Any other target, a missing plist, `launchctl` or identity: silent no-op.
   The auto-worker's own linger window (section 9) is a separate loop in `worker.mjs`, not this hook.

6. Unclaimed-task alert (section 11): if the poll reply carries `stale_alerts`, the hook also prints the block decision
   (with or without tasks of its own) and adds `"systemMessage"` with the alert text so the human sees it. The reason tells
   the agent to tell the operator and NOT to claim (R2, R3); the alert text is reduced to a safe character set (max 5, 160 chars each).

Log: `~/.agency-board/linger.log` (ISO timestamps, ids and counts only; no tokens, no task titles or bodies).
Test knobs: `AGENCY_BOARD_LINGER_INTERVAL`, `AGENCY_BOARD_LINGER_WINDOW` (seconds; put them in the hook command to try it quickly).

Codex: Codex 0.160 has a `Stop` event with the same `decision: block`. The Codex linger hooks also need
`AGENCY_BOARD_TOKEN_CODEX` in the environment (set by the `~/.zshrc` block). The launchd auto-worker's `codex exec` has neither
that variable (its env is an allowlist) nor the agency-board MCP tools, so it cannot reach a marker or linger.
Not covered: Windows (`connect.ps1`), Hermes and Grok (no equivalent stop hook known; the launchd worker polls on its own).

## 11. Unclaimed-task alert (notify only)

A task handed to an agent that nobody claims is easy to miss when that agent is idle or offline. After
`STALE_TASK_MIN_MINUTES` (default 30) the server tells the other agents that poll, so a human hears about it. Nothing is
claimed on the strength of an alert: R2/R3 are unchanged, and the worker never works a task that was not handed to it.

- **Stale** = status `open`, `handoff_to` set, waited longer than X. The clock is `updated_at` (creation, handoff and
  release all set it), so a just-released task does not alert at once. Unassigned open tasks are the operator's tracker items
  and never alert. Claimed, blocked, done, failed or cancelled tasks stop alerting.
- **No cron, no always-on**: the alert is computed on polls agents already make. `GET /tasks` (REST and MCP `list_tasks`)
  and `GET /inbox` add `stale_alerts: ["unclaimed task for <Y>: <title>, waiting N min", ...]` (key absent when empty; max 5
  per poll). The heartbeat reply carries nothing (hooks discard it). The caller is "active" by being a poll; the dashboard
  (`/dashboard/tasks`) shows the same flag for the nobody-active case, with the agent@machine identities seen within
  `STALE_ACTIVE_MIN_MINUTES` (default 10; `agent_tokens.last_used_at` / heartbeat, because `devices.last_seen_at` is per machine).
- **Whose entry**: the task's own target (`handoff_to` = the poller's agent or agent@machine) sees it in its normal inbox
  and gets no alert. Namespaces the poller cannot read are never named.
- **Once per agent per task**, no schema change: the first poll that returns an alert records a `task_events` row
  (`actor` = the poller's agent@machine, `kind` `update`, `note` `stale-alert`; shown in the task timeline). Later polls skip
  tasks with that row. A failed insert never fails the poll.
- **Surfaces**: SessionStart hook (`inbox?format=text`, section 2), linger hook (section 10), MCP `list_tasks`, dashboard.
  The auto-worker (section 9) polls `/tasks?mine=1&status=open&stale=peek`: it gets the alert without recording it (so a
  human-facing hook on the same identity still sees it) and only logs `stale-task alert (notify only, not claimed): ...`.
  `stale=peek` is REST only; the MCP schema drops it.
- **Knobs** (server env, read per request): `STALE_TASK_MIN_MINUTES` (30), `STALE_ACTIVE_MIN_MINUTES` (10). Titles in an
  alert are untrusted (R1): control characters, quotes, brackets and braces removed, 120 characters.
