// connect.ps1, served by app/connect.ps1/route.ts with __AGENCY_BOARD_BASE_URL__ replaced.
// Windows PowerShell 5.1 compatible. The script must contain no backtick (it is
// both the PowerShell escape char and the JS template delimiter) and no
// dollar-brace sequence, so newlines are [char]10 and variables are plain $Name.
// It runs via "irm | iex" in the user's own session: it never calls exit, and
// everything lives inside one script block so no variables leak.
import { AGENTS } from "../config";

// Agent wiring: claude and codex are real CLIs and get vendor-specific setup. hermes is not supported on Windows
// (warned). Every other agent in AGENCY_BOARD_AGENTS (default also "grok") only gets its token saved to
// $HOME\.agency-board\<agent>.token. The token loop is generated from the configured agent list.
const PS_AGENTS = AGENTS.filter((a) => a !== "hermes")
  .map((a) => `'${a}'`)
  .join(", ");

export const CONNECT_PS1 = String.raw`# agency-board connect script (Windows PowerShell 5.1+).
#   $env:AGENCY_BOARD_CODE='<CODE>'; irm __AGENCY_BOARD_BASE_URL__/connect.ps1 | iex
# Re-running is safe: marker blocks are replaced, and every file is backed up as
# <file>.bak-agency-board-<timestamp> before it is changed. No Hermes on Windows.
# Optional: $env:AGENCY_BOARD_NO_HEARTBEAT='1' skips the Claude heartbeat hooks.
# Upgrade hooks only (no code, MCP config untouched): $env:AGENCY_BOARD_HOOKS_ONLY='1'; irm __AGENCY_BOARD_BASE_URL__/connect.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $HubBase = '__AGENCY_BOARD_BASE_URL__'
  $MB = '# >>> agency-board >>>'
  $ME = '# <<< agency-board <<<'
  $NL = [string][char]10
  $TS = Get-Date -Format 'yyyyMMddHHmmss'
  $HubDir = Join-Path $HOME '.agency-board'
  $Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  $Changed = New-Object System.Collections.ArrayList
  $Backups = New-Object System.Collections.ArrayList
  $Warnings = New-Object System.Collections.ArrayList

  function Say([string]$Msg) { Write-Host ('agency-board: ' + $Msg) }
  function Warn([string]$Msg) {
    Write-Host ('agency-board: WARNING: ' + $Msg) -ForegroundColor Yellow
    [void]$Warnings.Add($Msg)
  }

  function Backup-File([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      $b = $Path + '.bak-agency-board-' + $TS
      Copy-Item -LiteralPath $Path -Destination $b -Force
      [void]$Backups.Add($b)
    }
  }

  function Read-Text([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) { return [IO.File]::ReadAllText($Path) }
    return ''
  }

  # Write UTF-8 without BOM (TOML/JSON parsers reject a BOM), only when content differs.
  function Write-IfChanged([string]$Path, [string]$Text) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      if ([IO.File]::ReadAllText($Path) -ceq $Text) { return }
    }
    Backup-File $Path
    [IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
    [void]$Changed.Add($Path)
  }

  function Remove-Block([string]$Text) {
    $out = New-Object System.Collections.ArrayList
    $skip = $false
    foreach ($line in ($Text -split '\r?\n')) {
      $t = $line.Trim()
      if ($t -eq $MB) { $skip = $true; continue }
      if ($t -eq $ME) { $skip = $false; continue }
      if (-not $skip) { [void]$out.Add($line) }
    }
    return (($out -join $NL).TrimEnd([char]13, [char]10))
  }

  function Set-Block([string]$Path, [string]$Content) {
    $kept = Remove-Block (Read-Text $Path)
    $new = ''
    if ($kept.Length -gt 0) { $new = $kept + $NL }
    $new = $new + $MB + $NL + $Content + $NL + $ME + $NL
    Write-IfChanged $Path $new
  }

  # Native commands: stderr must not become a terminating error under 'Stop' (PS 5.1).
  function Invoke-Native([string]$Exe, [string[]]$ArgList) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $Exe @ArgList 2>&1 | Out-Null
      return $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prev
    }
  }

  function Find-App([string[]]$Names) {
    foreach ($n in $Names) {
      $c = Get-Command $n -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($c) { return $c.Source }
    }
    return $null
  }

  function Get-Prop($Obj, [string]$Name) {
    $p = $Obj.PSObject.Properties[$Name]
    if ($null -eq $p) { return $null }
    return $p.Value
  }

  try {
    # 1. code, TLS 1.2
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $noHeartbeat = ([string]$env:AGENCY_BOARD_NO_HEARTBEAT -eq '1')
    $hooksOnly = ([string]$env:AGENCY_BOARD_HOOKS_ONLY -eq '1')
    $tokens = @{}
    if ($hooksOnly) {
      # Upgrade an already-connected machine: no code exchange, no MCP/config edits;
      # only heartbeat.ps1 and the Claude hooks are (re)written from the existing token.
      if ($noHeartbeat) { throw 'AGENCY_BOARD_HOOKS_ONLY and AGENCY_BOARD_NO_HEARTBEAT together leave nothing to do' }
      $tf = Join-Path $HubDir 'claude.token'
      $t = (Read-Text $tf).Trim()
      if ($t.Length -eq 0) { throw ('no existing ' + $tf + '. AGENCY_BOARD_HOOKS_ONLY only upgrades an already-connected machine; connect with a code first.') }
      if ($t -cnotmatch '^agency-board_claude_[A-Za-z0-9_-]+$') { throw ($tf + ' does not hold a valid claude token; reconnect with a code') }
      $apiBase = $HubBase.TrimEnd('/')
      if ($apiBase -notmatch '^https?://[A-Za-z0-9:/._-]+$') { throw ('AGENCY_BOARD_HOOKS_ONLY needs an http(s) base URL, got: ' + $apiBase) }
      $serverUrl = $apiBase + '/api/mcp'
      $machine = [string]$env:COMPUTERNAME
      $tokens['claude'] = $t
    } else {
      $code = [string]$env:AGENCY_BOARD_CODE
      $code = ($code.ToUpper() -replace '[\s-]', '')
      if ($code.Length -eq 0) { throw ('missing connect code. Usage: $env:AGENCY_BOARD_CODE=''<CODE>''; irm ' + $HubBase + '/connect.ps1 | iex') }
      if ($code -cnotmatch '^[ABCDEFGHJKMNPQRSTVWXYZ23456789]+$') { throw ('connect code has invalid characters: ' + $code) }

      # 2. exchange (test hook: only a file:// base reads $env:AGENCY_BOARD_TEST_RESPONSE_FILE)
      $resp = $null
      if ($HubBase.StartsWith('file://')) {
        $resp = (Read-Text ([string]$env:AGENCY_BOARD_TEST_RESPONSE_FILE)) | ConvertFrom-Json
      } else {
        $body = @{ code = $code; hostname = [string]$env:COMPUTERNAME; os = 'windows' } | ConvertTo-Json -Compress
        try {
          $resp = Invoke-RestMethod -Method Post -Uri ($HubBase + '/api/connect/exchange') -ContentType 'application/json' -Body $body -TimeoutSec 30 -UseBasicParsing
        } catch {
          # capture now: a nested catch below would rebind the automatic $_
          $err = $_
          $status = ''
          $detail = ''
          if ($err.Exception.Response) { try { $status = [string][int]$err.Exception.Response.StatusCode } catch { } }
          $errText = ''
          if ($err.ErrorDetails -and $err.ErrorDetails.Message) { $errText = $err.ErrorDetails.Message }
          if (-not $errText -and $err.Exception.Response) {
            try {
              $reader = New-Object System.IO.StreamReader($err.Exception.Response.GetResponseStream())
              $errText = $reader.ReadToEnd()
            } catch { }
          }
          if ($errText) {
            try { $e = ($errText | ConvertFrom-Json).error; $detail = [string]$e.code + ': ' + [string]$e.message } catch { $detail = $errText }
          } else {
            $detail = $err.Exception.Message
          }
          throw ('exchange failed: HTTP ' + $status + ' ' + $detail)
        }
      }
      $data = $resp.data
      if ($null -eq $data) { throw 'exchange response has no data' }
      $serverUrl = [string]$data.server_url
      if ($serverUrl -notmatch '^https?://[A-Za-z0-9:/._-]+$') { throw 'exchange response has no valid server_url' }
      $apiBase = $serverUrl -replace '/api/mcp$', ''
      $machine = [string]$data.machine

      # 3. tokens in $HOME\.agency-board, ACL current user only
      if (-not (Test-Path -LiteralPath $HubDir)) { New-Item -ItemType Directory -Path $HubDir | Out-Null }
      $who = [Security.Principal.WindowsIdentity]::GetCurrent().Name
      $rc = Invoke-Native 'icacls' @($HubDir, '/inheritance:r', '/grant:r', ($who + ':(OI)(CI)F'))
      if ($rc -ne 0) { Warn ('icacls failed on ' + $HubDir + ' (exit ' + $rc + '); tokens may be readable by other local users') }
      foreach ($ag in @(${PS_AGENTS})) {
        $t = [string](Get-Prop $data ('token_' + $ag))
        if ($t.Length -eq 0) { continue }
        if ($t -cnotmatch ('^agency-board_' + $ag + '_[A-Za-z0-9_-]+$')) { throw ('malformed ' + $ag + ' token in response') }
        $tf = Join-Path $HubDir ($ag + '.token')
        [IO.File]::WriteAllText($tf, $t + $NL, $Utf8NoBom)
        $rc = Invoke-Native 'icacls' @($tf, '/inheritance:r', '/grant:r', ($who + ':F'))
        $tokens[$ag] = $t
        [void]$Changed.Add($tf)
      }
      if ($null -ne (Get-Prop $data 'token_hermes')) { Warn 'a hermes token was issued but Hermes is not configured on Windows' }
      if ($tokens.Count -eq 0) { throw 'exchange returned no usable tokens' }

      # 4. Claude Code
      if ($tokens.ContainsKey('claude')) {
        $claude = Find-App @('claude', 'claude.cmd')
        if ($null -eq $claude) {
          Warn ('claude CLI not found on PATH; token saved in ' + (Join-Path $HubDir 'claude.token'))
        } else {
          try {
            Backup-File (Join-Path $HOME '.claude.json')
            $null = Invoke-Native $claude @('mcp', 'remove', '-s', 'user', 'agency-board')
            $rc = Invoke-Native $claude @('mcp', 'add', '--transport', 'http', '-s', 'user', 'agency-board', $serverUrl, '--header', ('Authorization: Bearer ' + $tokens['claude']))
            if ($rc -eq 0) { [void]$Changed.Add((Join-Path $HOME '.claude.json') + ' (claude mcp add -s user agency-board)') }
            else { Warn ('claude mcp add failed (exit ' + $rc + '); see docs/connect.md for the manual command') }
          } catch { Warn ('claude setup failed: ' + $_.Exception.Message) }
        }
      }

      # 5. Codex: config.toml marker block + user env var AGENCY_BOARD_TOKEN_CODEX
      if ($tokens.ContainsKey('codex')) {
        $codexDir = Join-Path $HOME '.codex'
        if ((Find-App @('codex', 'codex.cmd')) -or (Test-Path -LiteralPath $codexDir)) {
          try {
            if (-not (Test-Path -LiteralPath $codexDir)) { New-Item -ItemType Directory -Path $codexDir | Out-Null }
            $cfg = Join-Path $codexDir 'config.toml'
            if ((Remove-Block (Read-Text $cfg)) -match '(?m)^\s*\[mcp_servers\.agency-board\]') {
              Warn ($cfg + ' already has [mcp_servers.agency-board] outside the agency-board block; left unchanged')
            } else {
              Set-Block $cfg ('[mcp_servers.agency-board]' + $NL + 'url = "' + $serverUrl + '"' + $NL + 'bearer_token_env_var = "AGENCY_BOARD_TOKEN_CODEX"')
            }
            # .NET call instead of setx: same HKCU\Environment write, but the token never
            # appears on a process command line.
            [Environment]::SetEnvironmentVariable('AGENCY_BOARD_TOKEN_CODEX', $tokens['codex'], 'User')
            $env:AGENCY_BOARD_TOKEN_CODEX = $tokens['codex']
            [void]$Changed.Add('user environment variable AGENCY_BOARD_TOKEN_CODEX')
          } catch { Warn ('codex setup failed: ' + $_.Exception.Message) }
        } else {
          Warn ('codex not found; token saved in ' + (Join-Path $HubDir 'codex.token'))
        }
      }
    }

    # 6b. agent guide: best-effort copy of GET /api/v1/guide?format=text to guide.txt (never fatal; 404 until the route ships)
    try {
      $gt = $null
      foreach ($ag in @('claude', 'codex')) { if ($null -eq $gt -and $tokens.ContainsKey($ag)) { $gt = $tokens[$ag] } }
      if ($null -ne $gt) {
        $gr = Invoke-WebRequest -Uri ($apiBase + '/api/v1/guide?format=text') -Headers @{ Authorization = ('Bearer ' + $gt) } -TimeoutSec 10 -UseBasicParsing
        $gtxt = [string]$gr.Content
        if ($gtxt.Length -gt 0) { Write-IfChanged (Join-Path $HubDir 'guide.txt') $gtxt }
      }
    } catch { Say 'agent guide not available yet (optional, skipped)' }

    # 6c. Codex AGENTS.md pointer: idempotent marked block, replaced in place, never duplicated (never fatal)
    try {
      $agDir = Join-Path $HOME '.codex'
      if (-not (Test-Path -LiteralPath $agDir)) { New-Item -ItemType Directory -Path $agDir | Out-Null }
      $agf = Join-Path $agDir 'AGENTS.md'
      $agB = '<!-- BEGIN agency-board -->'
      $agE = '<!-- END agency-board -->'
      $agBlock = $agB + $NL + 'agency-board (shared memory and task board): read ~/.agency-board/guide.txt first.' + $NL + ('Public guide: ' + $apiBase + '/llms.txt') + $NL + ('Full guide for your identity: GET ' + $apiBase + '/api/v1/guide (Bearer token from ~/.agency-board/codex.token).') + $NL + $agE
      $agOut = New-Object System.Collections.ArrayList
      $agDone = $false
      $agSkip = $false
      $agHasEnd = $false
      $agLines = @()
      $agText = Read-Text $agf
      if ($agText.Length -gt 0) { $agLines = @($agText -split '\r?\n') }
      foreach ($l in $agLines) { if ($l.Trim() -eq $agE) { $agHasEnd = $true } }
      $agHasBegin = $false
      foreach ($l in $agLines) { if ($l.Trim() -eq $agB) { $agHasBegin = $true } }
      if ($agHasBegin -and -not $agHasEnd) {
        Warn ($agf + ' has an agency-board BEGIN marker without END; left unchanged')
      } else {
        foreach ($l in $agLines) {
          $lt = $l.Trim()
          if ($lt -eq $agB) { if (-not $agDone) { [void]$agOut.Add($agBlock) }; $agDone = $true; $agSkip = $true; continue }
          if ($lt -eq $agE) { $agSkip = $false; continue }
          if (-not $agSkip) { [void]$agOut.Add($l) }
        }
        $agNew = ($agOut -join $NL)
        if (-not $agDone) {
          $agNew = $agNew.TrimEnd([char]13, [char]10)
          if ($agNew.Length -gt 0) { $agNew = $agNew + $NL + $NL }
          $agNew = $agNew + $agBlock
        }
        $agNew = $agNew.TrimEnd([char]13, [char]10) + $NL
        Write-IfChanged $agf $agNew
      }
    } catch { Warn ('AGENTS.md pointer failed: ' + $_.Exception.Message) }

    # 7. heartbeat hook (Claude Code SessionStart + Stop)
    if ($tokens.ContainsKey('claude') -and -not $noHeartbeat) {
      try {
        $hb = Join-Path $HubDir 'heartbeat.ps1'
        $hbText = @'
# agency-board heartbeat (installed by connect.ps1). Never blocks or fails a session.
# On session-start it also prints this identity's pending tasks; Claude Code adds
# SessionStart hook stdout to the session context. Any failure is silent.
$ErrorActionPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $t = ([IO.File]::ReadAllText((Join-Path $HOME '.agency-board\claude.token'))).Trim()
  $auth = @{ Authorization = ('Bearer ' + $t) }
  $note = 'unknown'
  if ($args.Count -gt 0) { $note = [string]$args[0] }
  $body = @{ status_note = $note } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri '@AGENCY_BOARD_API_BASE@/api/v1/heartbeat' -Headers $auth -ContentType 'application/json' -Body $body -TimeoutSec 3 -UseBasicParsing | Out-Null
  } catch { }
  if ($note -eq 'session-start') {
    if (Test-Path -LiteralPath (Join-Path $HOME '.agency-board\guide.txt')) { [Console]::Out.WriteLine('agency-board: how to use the shared memory + task board: read ~/.agency-board/guide.txt') }
    try {
      $r = Invoke-WebRequest -Uri '@AGENCY_BOARD_API_BASE@/api/v1/inbox?format=text' -Headers $auth -TimeoutSec 3 -UseBasicParsing
      $txt = [string]$r.Content
      if ($txt.Length -gt 0) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Out.WriteLine($txt.TrimEnd([char]13, [char]10))
      }
    } catch { }
  }
} catch { }
exit 0
'@
        Write-IfChanged $hb ($hbText.Replace('@AGENCY_BOARD_API_BASE@', $apiBase).Replace([string][char]13, '') + $NL)

        $sj = Join-Path $HOME '.claude\settings.json'
        $claudeDir = Join-Path $HOME '.claude'
        if (-not (Test-Path -LiteralPath $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
        $raw = Read-Text $sj
        $obj = $null
        if ($raw.Trim().Length -gt 0) { $obj = $raw | ConvertFrom-Json }
        if ($null -eq $obj) { $obj = [pscustomobject]@{} }
        if (-not ($obj -is [System.Management.Automation.PSCustomObject])) { throw 'settings.json is not a JSON object' }
        if ($null -eq $obj.PSObject.Properties['hooks']) { $obj | Add-Member -NotePropertyName 'hooks' -NotePropertyValue ([pscustomobject]@{}) }
        $hooks = $obj.hooks
        if (-not ($hooks -is [System.Management.Automation.PSCustomObject])) { throw 'settings.json hooks is not an object' }
        # Forward slashes work in both cmd and Git Bash; Bypass because the default policy blocks -File.
        $cmdBase = 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + $hb.Replace('\', '/') + '"'
        $added = 0
        foreach ($ev in @('SessionStart', 'Stop')) {
          $arg = 'stop'
          if ($ev -eq 'SessionStart') { $arg = 'session-start' }
          $prop = $hooks.PSObject.Properties[$ev]
          $list = @()
          if ($null -ne $prop -and $null -ne $prop.Value) { $list = @($prop.Value) }
          $found = $false
          foreach ($entry in $list) {
            if ($null -eq $entry) { continue }
            foreach ($h in @(Get-Prop $entry 'hooks')) {
              if ($null -ne $h -and ([string](Get-Prop $h 'command')) -like '*agency-board*heartbeat*') { $found = $true }
            }
          }
          if (-not $found) {
            $list += [pscustomobject]@{ matcher = ''; hooks = @([pscustomobject]@{ type = 'command'; command = ($cmdBase + ' ' + $arg) }) }
            if ($null -ne $prop) { $prop.Value = $list }
            else { $hooks | Add-Member -NotePropertyName $ev -NotePropertyValue $list }
            $added++
          }
        }
        if ($added -gt 0) {
          # PS 5.1 quirk: the System.Array ETS Count member makes ConvertTo-Json emit
          # PSObject-wrapped arrays as {"value":[...],"Count":n}. Removing it is the
          # standard fix (intrinsic .Count still works); no-op on PowerShell 7.
          try { Remove-TypeData -TypeName System.Array -ErrorAction SilentlyContinue } catch { }
          Write-IfChanged $sj (($obj | ConvertTo-Json -Depth 100) + $NL)
        }
      } catch { Warn ('heartbeat hook setup failed (settings.json left unchanged): ' + $_.Exception.Message) }
    }

    # 8. summary
    if ($hooksOnly) { Say ('hooks updated for ' + $apiBase + ' (no code exchange, MCP config untouched)') }
    else { Say ('connected machine ' + $machine + ' to ' + $serverUrl) }
    foreach ($ag in $tokens.Keys) { Say ('  ' + $ag + '@' + $machine + '  token ' + $tokens[$ag].Substring(0, ('agency-board_' + $ag + '_').Length + 4) + '...') }
    if ($Changed.Count -gt 0) { Write-Host 'Files changed:'; foreach ($c in $Changed) { Write-Host ('  ' + $c) } }
    if ($Backups.Count -gt 0) { Write-Host 'Backups:'; foreach ($c in $Backups) { Write-Host ('  ' + $c) } }
    if ($Warnings.Count -gt 0) { Write-Host 'Warnings:'; foreach ($c in $Warnings) { Write-Host ('  ' + $c) } }
    Say 'Open a new terminal, then restart your Claude/Codex sessions.'
    Say ('agent guide: ' + $apiBase + '/llms.txt | full: GET ' + $apiBase + '/api/v1/guide (token)')
  } catch {
    Write-Host ('agency-board: ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    $global:LASTEXITCODE = 1
  }
}
`;
