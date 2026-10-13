// connect.sh, served by app/connect.sh/route.ts with __AGENCY_BOARD_BASE_URL__ replaced.
// The linger.sh hook script lives in lingerSh.ts and is spliced into the heredoc at the
// __AGENCY_BOARD_LINGER_SH__ placeholder (end of this file), so tests can also import it directly.
// Agent wiring: claude, codex and hermes are real CLIs and get vendor-specific setup (step_claude/step_codex/
// step_hermes). Every other agent in AGENCY_BOARD_AGENTS (default also "grok") only gets its token saved to
// ~/.agency-board/<agent>.token. The token loop below is generated from the configured agent list.
// String.raw keeps every backslash verbatim. The script must never contain a
// backtick or a dollar-brace sequence (JS would interpolate it), so it uses
// $(...) and plain $VAR only; the one literal dollar-brace the Hermes YAML
// needs is assembled inside awk. POSIX sh: runs under macOS /bin/sh (bash 3.2).
import { AGENTS } from "../config";
import { LINGER_SH } from "./lingerSh";

const CONNECT_SH_TEMPLATE = String.raw`#!/bin/sh
# agency-board connect script (macOS / Linux).
#   curl -fsSL __AGENCY_BOARD_BASE_URL__/connect.sh | sh -s <CODE> [--no-heartbeat]
#   curl -fsSL __AGENCY_BOARD_BASE_URL__/connect.sh | sh -s -- --hooks-only   (upgrade hooks only)
#   curl -fsSL __AGENCY_BOARD_BASE_URL__/connect.sh | sh -s -- --worker       (install the codex auto-worker, macOS)
#   curl -fsSL __AGENCY_BOARD_BASE_URL__/connect.sh | sh -s -- --worker-uninstall
# Re-running is safe: every edit is an idempotent marker block, and every file
# is backed up as <file>.bak-agency-board-<timestamp> before it is changed.
# Test hook: only when AGENCY_BOARD_BASE is a file:// URL (a served script never is), the
# exchange response is read from $AGENCY_BOARD_TEST_RESPONSE_FILE instead of POSTed.

AGENCY_BOARD_BASE='__AGENCY_BOARD_BASE_URL__'
MB='# >>> agency-board >>>'
ME='# <<< agency-board <<<'
TS=$(date +%Y%m%d%H%M%S)
AGENCY_BOARD_DIR="$HOME/.agency-board"
CHANGED=''
BACKUPS=''
WARNINGS=''
umask 077

say() { printf '%s\n' "agency-board: $*"; }
warn() {
  printf '%s\n' "agency-board: WARNING: $*" >&2
  WARNINGS="$WARNINGS
  $*"
}
die() { printf '%s\n' "agency-board: ERROR: $*" >&2; exit 1; }

# backup <file>: copy to <file>.bak-agency-board-<ts> if it exists.
backup() {
  [ -f "$1" ] || return 0
  cp -p "$1" "$1.bak-agency-board-$TS" || die "could not back up $1"
  BACKUPS="$BACKUPS
  $1.bak-agency-board-$TS"
}

# commit_file <tmp> <file>: install tmp over file when the content differs.
# cat-over (not mv) keeps the file's permissions and any symlink (dotfiles).
commit_file() {
  if [ -f "$2" ] && cmp -s "$1" "$2"; then rm -f "$1"; return 0; fi
  backup "$2"
  cat "$1" > "$2" || { rm -f "$1"; die "could not write $2"; }
  rm -f "$1"
  CHANGED="$CHANGED
  $2"
}

newtmp() { mktemp "$AGENCY_BOARD_DIR/tmp.XXXXXX" || die "mktemp failed in $AGENCY_BOARD_DIR"; }

# strip_block <file>: print file without the agency-board marker block (any indent).
strip_block() {
  awk -v b="$MB" -v e="$ME" '
    { t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t) }
    t == b { skip = 1; next }
    t == e { skip = 0; next }
    !skip { print }' "$1"
}

# end_nl <file>: make sure a non-empty file ends with a newline.
end_nl() {
  if [ -s "$1" ] && [ -n "$(tail -c 1 "$1")" ]; then printf '\n' >> "$1"; fi
}

# set_block <file> <content>: replace (or append) the marker block at EOF.
set_block() {
  tmp=$(newtmp)
  if [ -f "$1" ]; then strip_block "$1" > "$tmp"; fi
  end_nl "$tmp"
  printf '%s\n%s\n%s\n' "$MB" "$2" "$ME" >> "$tmp"
  commit_file "$tmp" "$1"
}

# jget <key>: string value of "key":"..." in the one-line JSON response.
jget() { printf '%s' "$RESP" | sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' | head -n 1; }

has() { case " $ISSUED " in *" $1 "*) return 0 ;; esac; return 1; }
tok() { cat "$AGENCY_BOARD_DIR/$1.token"; }
# tokpfx <agent>: display prefix = agency-board_<agent>_ plus 4 random chars (never a fixed width).
tokpfx() { awk -v p="agency-board_$1" 'NR == 1 { print substr($0, 1, length(p) + 5) }' "$AGENCY_BOARD_DIR/$1.token"; }

step_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    warn "claude CLI not found on PATH; token saved in $AGENCY_BOARD_DIR/claude.token"
    return 0
  fi
  backup "$HOME/.claude.json"
  claude mcp remove -s user agency-board </dev/null >/dev/null 2>&1
  if claude mcp add --transport http -s user agency-board "$SERVER_URL" --header "Authorization: Bearer $(tok claude)" </dev/null >/dev/null 2>&1; then
    CHANGED="$CHANGED
  $HOME/.claude.json (claude mcp add -s user agency-board)"
  else
    warn "claude mcp add failed. Run: claude mcp add --transport http -s user agency-board $SERVER_URL --header \"Authorization: Bearer \$(cat ~/.agency-board/claude.token)\""
  fi
}

step_codex() {
  if ! command -v codex >/dev/null 2>&1 && [ ! -d "$HOME/.codex" ]; then
    warn "codex not found; token saved in $AGENCY_BOARD_DIR/codex.token"
    return 0
  fi
  mkdir -p "$HOME/.codex" || die "cannot create $HOME/.codex"
  CFG="$HOME/.codex/config.toml"
  if [ -f "$CFG" ] && strip_block "$CFG" | grep -q '^[[:space:]]*\[mcp_servers\.agency-board\]'; then
    warn "$CFG already has [mcp_servers.agency-board] outside the agency-board block; left unchanged"
  else
    set_block "$CFG" "[mcp_servers.agency-board]
url = \"$SERVER_URL\"
bearer_token_env_var = \"AGENCY_BOARD_TOKEN_CODEX\""
  fi
  RCLINE='export AGENCY_BOARD_TOKEN_CODEX="$(cat "$HOME/.agency-board/codex.token" 2>/dev/null)"'
  set_block "$HOME/.zshrc" "$RCLINE"
  if [ -f "$HOME/.bash_profile" ]; then set_block "$HOME/.bash_profile" "$RCLINE"; fi
  CODEX_OK=1
}

step_hermes() {
  HCFG="$HOME/.hermes/config.yaml"
  HENV="$HOME/.hermes/.env"
  if ! command -v hermes >/dev/null 2>&1 && [ ! -f "$HCFG" ]; then
    warn "hermes not found; token saved in $AGENCY_BOARD_DIR/hermes.token"
    return 0
  fi
  mkdir -p "$HOME/.hermes" || die "cannot create $HOME/.hermes"

  # .env: replace the AGENCY_BOARD_TOKEN_HERMES line in place, or append it.
  tmp=$(newtmp)
  if [ -f "$HENV" ]; then src="$HENV"; else src=/dev/null; fi
  awk -v v="AGENCY_BOARD_TOKEN_HERMES=$(tok hermes)" '
    /^AGENCY_BOARD_TOKEN_HERMES=/ { if (!d) print v; d = 1; next }
    { print }
    END { if (!d) print v }' "$src" > "$tmp"
  commit_file "$tmp" "$HENV"

  # config.yaml: block right after the top-level mcp_servers: line.
  yin=$(newtmp)
  if [ -f "$HCFG" ]; then strip_block "$HCFG" > "$yin"; fi
  if grep -q '^[[:space:]][[:space:]]*agency-board:[[:space:]]*$' "$yin"; then
    rm -f "$yin"
    warn "$HCFG already has an agency-board entry outside the agency-board block; left unchanged"
    return 0
  fi
  tmp=$(newtmp)
  if ! awk -v url="$SERVER_URL" -v mb="$MB" -v me="$ME" -v d='$' '
    { line[NR] = $0 }
    END {
      m = 0
      for (i = 1; i <= NR; i++) {
        if (line[i] !~ /^mcp_servers:/) continue
        if (line[i] ~ /^mcp_servers:[ \t]*(#.*)?$/) { m = i; break }
        if (line[i] ~ /^mcp_servers:[ \t]*\{[ \t]*\}[ \t]*(#.*)?$/) { m = i; line[i] = "mcp_servers:"; break }
        exit 3
      }
      ind = "  "
      if (m) for (i = m + 1; i <= NR; i++) {
        if (line[i] ~ /^[ \t]*(#.*)?$/) continue
        if (match(line[i], /^ +/)) ind = substr(line[i], 1, RLENGTH)
        break
      }
      blk = ind mb "\n" ind "agency-board:\n" ind "  url: \"" url "\"\n" ind "  headers:\n" \
            ind "    Authorization: \"Bearer " d "{AGENCY_BOARD_TOKEN_HERMES}\"\n" ind me
      for (i = 1; i <= NR; i++) { print line[i]; if (i == m) print blk }
      if (!m) { print "mcp_servers:"; print blk }
    }' "$yin" > "$tmp"; then
    rm -f "$yin" "$tmp"
    warn "$HCFG has a non-block mcp_servers: value; add agency-board by hand (see docs/connect.md)"
    return 0
  fi
  rm -f "$yin"
  commit_file "$tmp" "$HCFG"
}

step_heartbeat() {
  HB="$AGENCY_BOARD_DIR/heartbeat.sh"
  tmp=$(newtmp)
  cat > "$tmp" <<'HBEOF'
#!/bin/sh
# agency-board heartbeat (installed by connect.sh). Never blocks or fails a session.
# On session-start it also prints this identity's pending tasks; Claude Code adds
# SessionStart hook stdout to the session context. Any failure is silent.
T=$(cat "$HOME/.agency-board/claude.token" 2>/dev/null) || exit 0
curl -fsS -m 3 -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' -d '{"status_note":"'"$1"'"}' "@AGENCY_BOARD_API_BASE@/api/v1/heartbeat" >/dev/null 2>&1 || true
if [ "$1" = session-start ]; then
  if [ -s "$HOME/.agency-board/guide.txt" ]; then echo "agency-board: how to use the shared memory + task board: read ~/.agency-board/guide.txt"; fi
  curl -fsS -m 3 -H "Authorization: Bearer $T" "@AGENCY_BOARD_API_BASE@/api/v1/inbox?format=text" 2>/dev/null || true
fi
exit 0
HBEOF
  tmp2=$(newtmp)
  sed "s#@AGENCY_BOARD_API_BASE@#$API_BASE#g" "$tmp" > "$tmp2"
  rm -f "$tmp"
  commit_file "$tmp2" "$HB"

  # linger.sh: post-task linger window (see docs/connect.md "Post-task linger window")
  tmp=$(newtmp)
  cat > "$tmp" <<'LGEOF'
__AGENCY_BOARD_LINGER_SH__
LGEOF
  tmp2=$(newtmp)
  sed "s#@AGENCY_BOARD_API_BASE@#$API_BASE#g" "$tmp" > "$tmp2"
  rm -f "$tmp"
  commit_file "$tmp2" "$AGENCY_BOARD_DIR/linger.sh"

  if ! command -v osascript >/dev/null 2>&1; then
    warn "osascript not found; add the SessionStart/Stop/PostToolUse hooks to ~/.claude/settings.json by hand (see docs/connect.md)"
    return 0
  fi
  mkdir -p "$HOME/.claude" || die "cannot create $HOME/.claude"
  apply_hooks "$HOME/.claude/settings.json" claude
}

# apply_hooks <settings-file> <claude|codex>: idempotent JSON merge with osascript -l JavaScript.
# claude: SessionStart + Stop heartbeat hooks, PostToolUse(complete_task) mark + Stop linger hooks.
# codex: only the linger hooks (Codex has no heartbeat hook). A hook is "present" when any command in
# that event already contains agency-board/heartbeat.sh or agency-board/linger.sh, so reruns add nothing
# and a heartbeat-only settings.json is upgraded with just the linger hooks. Backup first.
apply_hooks() {
  SJ="$1"
  JXA=$(newtmp)
  cat > "$JXA" <<'JXAEOF'
function run(argv) {
  var path = argv[0];
  var agent = argv[1];
  var obj = {};
  if ($.NSFileManager.defaultManager.fileExistsAtPath(path)) {
    var txt = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, null));
    if (txt === undefined || txt === null) throw new Error('cannot read ' + path);
    if (txt.replace(/\s/g, '') !== '') obj = JSON.parse(txt);
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('hooks file is not a JSON object');
  if (obj.hooks === undefined) obj.hooks = {};
  if (obj.hooks === null || typeof obj.hooks !== 'object' || Array.isArray(obj.hooks)) throw new Error('hooks is not an object');
  var added = 0;
  function ensure(ev, matcher, needle, command, timeout) {
    if (obj.hooks[ev] === undefined) obj.hooks[ev] = [];
    var list = obj.hooks[ev];
    if (!Array.isArray(list)) throw new Error('hooks.' + ev + ' is not an array');
    for (var i = 0; i < list.length; i++) {
      var hs = (list[i] && Array.isArray(list[i].hooks)) ? list[i].hooks : [];
      for (var j = 0; j < hs.length; j++) {
        if (hs[j] && typeof hs[j].command === 'string' && hs[j].command.indexOf(needle) >= 0) return;
      }
    }
    var h = { type: 'command', command: command };
    if (timeout) h.timeout = timeout;
    list.push({ matcher: matcher, hooks: [h] });
    added++;
  }
  var HB = 'agency-board/heartbeat.sh';
  var LG = 'agency-board/linger.sh';
  if (agent === 'claude') {
    ensure('SessionStart', '', HB, 'sh ~/.agency-board/heartbeat.sh session-start', 0);
    ensure('Stop', '', HB, 'sh ~/.agency-board/heartbeat.sh stop', 0);
  }
  // linger: mark a finished task, then (Stop) keep checking the board for up to 1800 s; hook timeout 1900 s
  ensure('PostToolUse', 'mcp__agency-board__complete_task', LG + ' mark', 'sh ~/.agency-board/linger.sh mark ' + agent, 0);
  ensure('Stop', '', LG + ' stop', 'sh ~/.agency-board/linger.sh stop ' + agent, 1900);
  // same-machine handoff: after a handoff / post_task, wake the launchd worker at once (launchctl kickstart, no -k; no-op without the worker)
  ensure('PostToolUse', 'mcp__agency-board__handoff|mcp__agency-board__post_task', LG + ' kick', 'sh ~/.agency-board/linger.sh kick ' + agent, 0);
  if (added === 0) return 'unchanged';
  var out = $.NSString.alloc.initWithUTF8String(JSON.stringify(obj, null, 2) + '\n');
  if (!out.writeToFileAtomicallyEncodingError(path, false, $.NSUTF8StringEncoding, null)) throw new Error('cannot write ' + path);
  return 'added';
}
JXAEOF
  # pre-change copy goes to a temp file and becomes the backup only if the merge changed something, so an
  # unchanged rerun (even within the same second) never deletes the backup an earlier run made
  SJB="$SJ.bak-agency-board-$TS"
  if [ -e "$SJB" ]; then SJB="$SJB.$$"; fi
  PRE=$(newtmp)
  if [ -f "$SJ" ]; then cp -p "$SJ" "$PRE" || die "could not back up $SJ"; fi
  R=$(osascript -l JavaScript "$JXA" "$SJ" "$2" </dev/null 2>&1)
  rm -f "$JXA"
  case "$R" in
    added)
      CHANGED="$CHANGED
  $SJ (agency-board $2 hooks)"
      if [ -s "$PRE" ]; then
        mv -f "$PRE" "$SJB"
        BACKUPS="$BACKUPS
  $SJB"
      else
        rm -f "$PRE"
      fi ;;
    unchanged) rm -f "$PRE" ;;
    *) rm -f "$PRE"; warn "could not add $2 hooks to $SJ: $R" ;;
  esac
}

# step_codex_linger: the linger Stop/PostToolUse hooks for Codex in ~/.codex/hooks.json. Codex has a Stop
# event with decision:block (codex-cli 0.160) but makes you trust each new hook once (/hooks in the CLI).
# Only when a codex token exists and ~/.codex is there; never creates a hooks.json for a codex that is not installed.
step_codex_linger() {
  [ -s "$AGENCY_BOARD_DIR/codex.token" ] || return 0
  [ -d "$HOME/.codex" ] || return 0
  if ! command -v osascript >/dev/null 2>&1; then
    warn "osascript not found; add the linger hooks to ~/.codex/hooks.json by hand (see docs/connect.md)"
    return 0
  fi
  CODEX_HOOKS_BEFORE="$CHANGED"
  apply_hooks "$HOME/.codex/hooks.json" codex
  if [ "$CHANGED" != "$CODEX_HOOKS_BEFORE" ]; then
    say "codex: new hooks in ~/.codex/hooks.json need one-time trust: run /hooks in Codex and trust the agency-board linger hooks"
  fi
}

# step_guide: best-effort copy of the agent guide (GET /api/v1/guide?format=text) to
# ~/.agency-board/guide.txt. Never fatal: no route yet (404) or no network keeps any old copy.
step_guide() {
  GT=''
  for ag in claude codex; do
    if [ -s "$AGENCY_BOARD_DIR/$ag.token" ]; then GT=$(head -n 1 "$AGENCY_BOARD_DIR/$ag.token" | tr -d '\r'); break; fi
  done
  [ -n "$GT" ] || return 0
  tmp=$(newtmp)
  if curl -fsS -m 10 -H "Authorization: Bearer $GT" -o "$tmp" "$API_BASE/api/v1/guide?format=text" </dev/null >/dev/null 2>&1 && [ -s "$tmp" ]; then
    if [ -f "$AGENCY_BOARD_DIR/guide.txt" ] && cmp -s "$tmp" "$AGENCY_BOARD_DIR/guide.txt"; then rm -f "$tmp"; return 0; fi
    mv -f "$tmp" "$AGENCY_BOARD_DIR/guide.txt" || { rm -f "$tmp"; return 0; }
    CHANGED="$CHANGED
  $AGENCY_BOARD_DIR/guide.txt"
  else
    rm -f "$tmp"
    say "agent guide not available yet (optional, skipped)"
  fi
}

# step_codex_guide: idempotent marked block in ~/.codex/AGENTS.md pointing Codex (no session
# hook) at the guide. Own HTML-comment markers (AGENTS.md is markdown). Replaces the block in
# place on rerun, never duplicates, never touches content outside the markers.
step_codex_guide() {
  AGF="$HOME/.codex/AGENTS.md"
  AGB='<!-- BEGIN agency-board -->'
  AGE='<!-- END agency-board -->'
  mkdir -p "$HOME/.codex" || { warn "cannot create $HOME/.codex; AGENTS.md pointer skipped"; return 0; }
  if [ -f "$AGF" ] && grep -qF "$AGB" "$AGF" && ! grep -qF "$AGE" "$AGF"; then
    warn "$AGF has an agency-board BEGIN marker without END; left unchanged"
    return 0
  fi
  AGENCY_BOARD_BLK="$AGB
agency-board (shared memory and task board): read ~/.agency-board/guide.txt first.
Public guide: $API_BASE/llms.txt
Full guide for your identity: GET $API_BASE/api/v1/guide (Bearer token from ~/.agency-board/codex.token).
$AGE"
  export AGENCY_BOARD_BLK
  tmp=$(newtmp)
  if [ -f "$AGF" ]; then src="$AGF"; else src=/dev/null; fi
  awk -v b="$AGB" -v e="$AGE" '
    { t = $0; sub(/^[ \t]+/, "", t); sub(/[ \t\r]+$/, "", t) }
    t == b { if (!done) print ENVIRON["AGENCY_BOARD_BLK"]; done = 1; skip = 1; next }
    t == e { skip = 0; next }
    !skip { print; last = $0 }
    END { if (!done) { if (NR > 0 && last != "") print ""; print ENVIRON["AGENCY_BOARD_BLK"] } }' "$src" > "$tmp"
  commit_file "$tmp" "$AGF"
}

WLABEL='com.agency-board.worker'

# worker_loaded: true while launchd still knows the service.
worker_loaded() { launchctl print "$WDOMAIN/$WLABEL" </dev/null >/dev/null 2>&1; }

# worker_unload: bootout is asynchronous, so a bootstrap right after it can fail with
# "Bootstrap failed: 5: Input/output error" while the old service is still tearing down.
# Boot out (a not-loaded error is fine), then wait up to ~10 s until launchd forgets the
# service. Returns 1 when it is still loaded after the wait.
worker_unload() {
  launchctl bootout "$WDOMAIN/$WLABEL" </dev/null >/dev/null 2>&1
  WI=0
  while worker_loaded; do
    if [ "$WI" -ge 10 ]; then return 1; fi
    sleep 1
    WI=$((WI + 1))
  done
  return 0
}

# worker_setup: shared checks for --worker / --worker-uninstall (no code exchange, no MCP edits).
worker_setup() {
  if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then die "HOME is not set"; fi
  command -v launchctl >/dev/null 2>&1 || die "--worker needs launchd (macOS)"
  WPL="$HOME/Library/LaunchAgents/$WLABEL.plist"
  WDOMAIN="gui/$(id -u)"
}

# worker_install: install the codex auto-worker as a LaunchAgent, using the existing
# ~/.agency-board/codex.token. worker.json is created once and never overwritten.
worker_install() {
  worker_setup
  command -v curl >/dev/null 2>&1 || die "curl is required"
  TF="$AGENCY_BOARD_DIR/codex.token"
  [ -s "$TF" ] || die "no existing $TF. --worker needs a connected codex; connect with a code first: curl -fsSL $AGENCY_BOARD_BASE/connect.sh | sh -s <CODE>"
  t=$(head -n 1 "$TF" | tr -d '\r')
  case "$t" in
    *[!A-Za-z0-9_-]*) die "$TF does not hold a valid codex token; reconnect with a code" ;;
    agency-board_codex_*) ;;
    *) die "$TF does not hold a valid codex token; reconnect with a code" ;;
  esac
  API_BASE=$(printf '%s' "$AGENCY_BOARD_BASE" | sed 's#/*$##')
  case "$API_BASE" in
    http://*|https://*) ;;
    *) die "--worker needs an http(s) base URL, got: $API_BASE" ;;
  esac
  case "$API_BASE" in *[!A-Za-z0-9:/._-]*) die "unexpected characters in base URL" ;; esac
  NODE=$(command -v node 2>/dev/null)
  case "$NODE" in /*) ;; *) die "node (>= 20) is required on PATH" ;; esac
  case "$NODE" in *[!A-Za-z0-9/._-]*) die "unexpected characters in the node path: $NODE" ;; esac
  chmod 700 "$AGENCY_BOARD_DIR"

  tmp=$(newtmp)
  curl -fsS -m 30 -o "$tmp" "$API_BASE/worker.mjs" </dev/null || { rm -f "$tmp"; die "could not download $API_BASE/worker.mjs"; }
  grep -q 'agency-board auto-worker' "$tmp" || { rm -f "$tmp"; die "downloaded worker.mjs is not the agency-board worker"; }
  commit_file "$tmp" "$AGENCY_BOARD_DIR/worker.mjs"

  WCFG="$AGENCY_BOARD_DIR/worker.json"
  WID="$AGENCY_BOARD_WORKER_IDENTITY"
  case "$WID" in codex@*) ;; *) WID='codex@CHANGE-ME' ;; esac
  case "$WID" in *[!A-Za-z0-9@._-]*) die "AGENCY_BOARD_WORKER_IDENTITY has unexpected characters" ;; esac
  if [ -f "$WCFG" ]; then
    say "kept existing $WCFG"
  else
    tmp=$(newtmp)
    cat > "$tmp" <<WCEOF
{
  "base_url": "$API_BASE",
  "identity": "$WID",
  "accept_director": true,
  "allow_assigned_by": [],
  "default_workdirs": true,
  "folders": {},
  "auto_push": false,
  "poll_seconds": 60,
  "timeout_minutes": 30
}
WCEOF
    commit_file "$tmp" "$WCFG"
  fi

  mkdir -p "$HOME/Library/LaunchAgents" || die "cannot create $HOME/Library/LaunchAgents"
  NODEDIR=$(dirname "$NODE")
  tmp=$(newtmp)
  cat > "$tmp" <<PLEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$WLABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$AGENCY_BOARD_DIR/worker.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODEDIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>WorkingDirectory</key><string>$AGENCY_BOARD_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$AGENCY_BOARD_DIR/worker.log</string>
  <key>StandardErrorPath</key><string>$AGENCY_BOARD_DIR/worker.log</string>
</dict>
</plist>
PLEOF
  commit_file "$tmp" "$WPL"
  worker_unload || warn "$WLABEL is still loaded 10 s after launchctl bootout; trying to bootstrap anyway"
  WN=0
  WERR=''
  while [ "$WN" -lt 5 ]; do
    WN=$((WN + 1))
    if WERR=$(launchctl bootstrap "$WDOMAIN" "$WPL" </dev/null 2>&1); then WERR=''; break; fi
    if [ "$WN" -lt 5 ]; then sleep 1; fi
  done
  if worker_loaded; then
    WLOADED=1
  else
    WLOADED=0
    WERR=$(printf '%s' "$WERR" | tr '\n' ' ')
    [ -n "$WERR" ] || WERR='no output'
    warn "launchctl bootstrap failed after $WN tries: $WERR. The worker is NOT loaded. Run: launchctl bootstrap $WDOMAIN $WPL"
  fi

  if [ "$WLOADED" = 1 ]; then
    say "auto-worker installed and loaded ($WLABEL), codex token $(tokpfx codex)..."
  else
    say "auto-worker files installed but the LaunchAgent is NOT loaded ($WLABEL); the worker is not running"
  fi
  if [ -n "$CHANGED" ]; then printf 'Files changed:%s\n' "$CHANGED"; fi
  if [ -n "$BACKUPS" ]; then printf 'Backups:%s\n' "$BACKUPS"; fi
  if [ -n "$WARNINGS" ]; then printf 'Warnings:%s\n' "$WARNINGS"; fi
  say "Next: edit $WCFG (identity; optional: allow_assigned_by for extra assigners, folders to map namespaces to repos). Tasks from the director are accepted by default."
  say "Logs: $AGENCY_BOARD_DIR/worker.log. The Mac must be awake to poll (optional: caffeinate -s, or pmset; see docs/connect.md)."
  # not loaded = not installed as far as the caller can tell: exit non-zero so a rerun or CI is honest
  [ "$WLOADED" = 1 ]
}

# worker_uninstall: stop and remove the LaunchAgent. Keeps worker.json, worker.mjs and the logs.
worker_uninstall() {
  worker_setup
  worker_unload && WSTOPPED=1 || WSTOPPED=0
  if [ -f "$WPL" ]; then rm -f "$WPL" || die "could not remove $WPL"; say "removed $WPL"; else say "no LaunchAgent at $WPL"; fi
  if [ "$WSTOPPED" = 1 ]; then
    say "auto-worker stopped. Kept $AGENCY_BOARD_DIR/worker.json, worker.mjs and worker.log."
  else
    warn "$WLABEL is still loaded 10 s after launchctl bootout. Run: launchctl bootout $WDOMAIN/$WLABEL"
    printf 'Warnings:%s\n' "$WARNINGS"
    say "plist removed but the auto-worker may still be running. Kept $AGENCY_BOARD_DIR/worker.json, worker.mjs and worker.log."
    return 1
  fi
}

# hooks_only: upgrade an already-connected machine. No code exchange and no
# MCP/config edits; only heartbeat.sh, linger.sh and the Claude (and Codex linger) hooks are (re)written,
# using the existing ~/.agency-board/claude.token.
hooks_only() {
  [ "$HEARTBEAT" = 1 ] || die "--hooks-only and --no-heartbeat together leave nothing to do"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then die "HOME is not set"; fi
  TF="$AGENCY_BOARD_DIR/claude.token"
  [ -s "$TF" ] || die "no existing $TF. --hooks-only only upgrades an already-connected machine; connect with a code first: curl -fsSL $AGENCY_BOARD_BASE/connect.sh | sh -s <CODE>"
  t=$(head -n 1 "$TF" | tr -d '
')
  case "$t" in
    *[!A-Za-z0-9_-]*) die "$TF does not hold a valid claude token; reconnect with a code" ;;
    agency-board_claude_*) ;;
    *) die "$TF does not hold a valid claude token; reconnect with a code" ;;
  esac
  API_BASE=$(printf '%s' "$AGENCY_BOARD_BASE" | sed 's#/*$##')
  case "$API_BASE" in
    http://*|https://*) ;;
    *) die "--hooks-only needs an http(s) base URL, got: $API_BASE" ;;
  esac
  case "$API_BASE" in *[!A-Za-z0-9:/._-]*) die "unexpected characters in base URL" ;; esac
  chmod 700 "$AGENCY_BOARD_DIR"

  step_heartbeat
  step_codex_linger
  step_guide
  step_codex_guide

  say "hooks updated for $API_BASE (no code exchange, MCP config untouched)"
  say "  claude  token $(tokpfx claude)..."
  if [ -n "$CHANGED" ]; then printf 'Files changed:%s\n' "$CHANGED"; else say "  heartbeat.sh, linger.sh and hooks already up to date"; fi
  if [ -n "$BACKUPS" ]; then printf 'Backups:%s\n' "$BACKUPS"; fi
  if [ -n "$WARNINGS" ]; then printf 'Warnings:%s\n' "$WARNINGS"; fi
  say "Restart your Claude sessions."
  say "agent guide: $API_BASE/llms.txt | full: GET $API_BASE/api/v1/guide (token)"
}

main() {
  CODE="$AGENCY_BOARD_CODE"
  HEARTBEAT=1
  HOOKS_ONLY=0
  WORKER=''
  if [ "$AGENCY_BOARD_NO_HEARTBEAT" = 1 ]; then HEARTBEAT=0; fi
  if [ "$AGENCY_BOARD_HOOKS_ONLY" = 1 ]; then HOOKS_ONLY=1; fi
  # flags may appear in any position: sh -s <CODE> --no-heartbeat, sh -s -- --hooks-only
  for a in "$@"; do
    case "$a" in
      --) ;;
      --no-heartbeat) HEARTBEAT=0 ;;
      --hooks-only) HOOKS_ONLY=1 ;;
      --worker) WORKER=install ;;
      --worker-uninstall) WORKER=uninstall ;;
      -*) die "unknown option: $a" ;;
      *) CODE=$a ;;
    esac
  done
  if [ -n "$WORKER" ]; then
    [ "$HOOKS_ONLY" = 0 ] || die "--worker and --hooks-only are separate steps; run them one at a time"
    [ -z "$CODE" ] || die "--worker takes no connect code (it uses the existing codex token)"
    if [ "$WORKER" = install ]; then worker_install; else worker_uninstall; fi
    return $?
  fi
  if [ "$HOOKS_ONLY" = 1 ]; then hooks_only; return $?; fi
  CODE=$(printf '%s' "$CODE" | tr 'abcdefghijklmnopqrstuvwxyz' 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' | tr -d ' -')
  case "$CODE" in
    '') die "missing connect code. Usage: curl -fsSL $AGENCY_BOARD_BASE/connect.sh | sh -s <CODE>" ;;
    *[!ABCDEFGHJKMNPQRSTVWXYZ23456789]*) die "connect code has invalid characters: $CODE" ;;
  esac
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if [ -z "$HOME" ] || [ ! -d "$HOME" ]; then die "HOME is not set"; fi
  case "$(uname -s)" in Darwin) OS=mac ;; Linux) OS=linux ;; *) OS='' ;; esac
  HOST=$(scutil --get ComputerName 2>/dev/null </dev/null || hostname 2>/dev/null)
  HOST=$(printf '%s' "$HOST" | tr -cd 'A-Za-z0-9 ._-' | cut -c1-64)

  mkdir -p "$AGENCY_BOARD_DIR" || die "cannot create $AGENCY_BOARD_DIR"
  chmod 700 "$AGENCY_BOARD_DIR"

  # 2. exchange the one-time code for tokens
  case "$AGENCY_BOARD_BASE" in
    file://*)
      [ -f "$AGENCY_BOARD_TEST_RESPONSE_FILE" ] || die "test mode needs AGENCY_BOARD_TEST_RESPONSE_FILE"
      RESP=$(cat "$AGENCY_BOARD_TEST_RESPONSE_FILE")
      HTTP=200
      if [ -n "$AGENCY_BOARD_TEST_HTTP_STATUS" ]; then HTTP=$AGENCY_BOARD_TEST_HTTP_STATUS; fi ;;
    *)
      BODY='{"code":"'"$CODE"'","hostname":"'"$HOST"'","os":"'"$OS"'"}'
      OUT=$(curl -sS -m 30 -X POST -H 'content-type: application/json' --data "$BODY" -w '\n%{http_code}' "$AGENCY_BOARD_BASE/api/connect/exchange" </dev/null) \
        || die "could not reach $AGENCY_BOARD_BASE (curl exit $?)"
      HTTP=$(printf '%s\n' "$OUT" | tail -n 1)
      RESP=$(printf '%s\n' "$OUT" | sed '$d') ;;
  esac
  case "$HTTP" in
    2??) ;;
    *) die "exchange failed: HTTP $HTTP $(jget code): $(jget message)" ;;
  esac

  SERVER_URL=$(jget server_url)
  MACHINE=$(jget machine)
  case "$SERVER_URL" in
    http://*|https://*) ;;
    *) die "exchange response has no server_url" ;;
  esac
  case "$SERVER_URL" in *[!A-Za-z0-9:/._-]*) die "unexpected characters in server_url" ;; esac
  API_BASE=$(printf '%s' "$SERVER_URL" | sed 's#/api/mcp$##')

  # 3. store tokens (dir 700, files 600)
  ISSUED=''
  for ag in ${AGENTS.join(" ")}; do
    t=$(jget "token_$ag")
    [ -n "$t" ] || continue
    case "$t" in
      *[!A-Za-z0-9_-]*) die "malformed $ag token in response" ;;
      agency-board_"$ag"_*) ;;
      *) die "malformed $ag token in response" ;;
    esac
    printf '%s\n' "$t" > "$AGENCY_BOARD_DIR/$ag.token" || die "cannot write $AGENCY_BOARD_DIR/$ag.token"
    chmod 600 "$AGENCY_BOARD_DIR/$ag.token"
    ISSUED="$ISSUED $ag"
    CHANGED="$CHANGED
  $AGENCY_BOARD_DIR/$ag.token"
  done
  [ -n "$ISSUED" ] || die "exchange returned no tokens"

  # 4-7. configure each agent
  if has claude; then step_claude; fi
  if has codex || [ -d "$HOME/.codex" ]; then step_codex; fi
  if has hermes || [ -f "$HOME/.hermes/config.yaml" ]; then step_hermes; fi
  if has claude && [ "$HEARTBEAT" = 1 ]; then step_heartbeat; fi
  if has codex && [ "$HEARTBEAT" = 1 ]; then step_codex_linger; fi
  step_guide
  step_codex_guide

  # 8. summary
  say "connected machine $MACHINE to $SERVER_URL"
  for ag in $ISSUED; do say "  $ag@$MACHINE  token $(tokpfx "$ag")..."; done
  if [ "$CODEX_OK" = 1 ]; then say "  codex configured ($HOME/.codex/config.toml)"; fi
  for ag in $ISSUED; do
    case "$ag" in
      claude|codex|hermes) ;;
      *) say "  $ag token saved in $AGENCY_BOARD_DIR/$ag.token (no local client to configure)" ;;
    esac
  done
  if [ -n "$CHANGED" ]; then printf 'Files changed:%s\n' "$CHANGED"; fi
  if [ -n "$BACKUPS" ]; then printf 'Backups:%s\n' "$BACKUPS"; fi
  if [ -n "$WARNINGS" ]; then printf 'Warnings:%s\n' "$WARNINGS"; fi
  say "Restart your Claude/Codex/Hermes sessions (open a new terminal first so Codex sees AGENCY_BOARD_TOKEN_CODEX)."
  say "agent guide: $API_BASE/llms.txt | full: GET $API_BASE/api/v1/guide (token)"
}

main "$@"
exit $?
`;

export const CONNECT_SH = CONNECT_SH_TEMPLATE.split("__AGENCY_BOARD_LINGER_SH__\n").join(LINGER_SH);
