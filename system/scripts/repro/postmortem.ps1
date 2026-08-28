# postmortem.ps1
# Orange5 sovereign-reproducibility postmortem collector.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- full effort; no theater; no silent fallback. When
#   bootstrap.ps1 / install.ps1 / verify.ps1 go RED, this script is the
#   honest forensic harvester. It does NOT try to fix anything. It does NOT
#   pretend things are green. It collects truth, packages it, and exits with
#   a single artifact the operator can hand back to future-Atom (or paste
#   into a chat with a teammate) for an actually-grounded diagnosis.
#
# Mission: When the sovereign-reproducibility loop is RED, produce one
#   shippable tarball (postmortem.tar.gz) that contains every piece of
#   evidence anyone will ask for in the next 60 seconds. No "could you also
#   send the logs?" round-trips. No "what version of node?" guesses.
#
# What this collects (all paths absolute, all originals copied -- never moved):
#   1. Per-daemon logs from 10-RECEIPTS/runtime-logs/  (gateway / hermes / 9-gate / guardrails)
#   2. Last 5 receipts from EACH receipt subdir (bootstrap, install, verify, build, runtime, etc.)
#   3. Environment state              -> env.txt        (env vars sanitized; PATH; PSVersion; OS; CPU; RAM)
#   4. Port snapshot                  -> ports.txt      (Get-NetTCPConnection on the 4 known ports + LISTEN sweep)
#   5. npm install output             -> npm.txt        (run npm ls + cached npm-debug.log; never re-runs install)
#   6. Process / service status       -> processes.txt  (Get-Process + Get-Service for daemons + Docker + Ollama)
#   7. Tool versions                  -> tools.txt      (node, bun, python, git, gh, docker, ollama --version)
#   8. Disk + free space              -> disk.txt
#   9. Recent Event Log errors        -> eventlog.txt   (Application + System, last 2h, level<=Error)
#  10. A top-level INDEX.md           -> human-readable narrative + sha256 of every file
#
# What this does NOT do (Mom's Law: one job per script):
#   - Fix anything                      -> bootstrap/install scripts own that
#   - Restart any daemon                -> install.ps1 owns boot
#   - Send anything off-host            -> operator ships the tarball deliberately
#   - Read secrets                      -> ATOMEONS_IDENTITY_SECRET et al are REDACTED in env.txt
#
# Idempotency: read-only against the source tree (and the receipt dirs). Writes
#   exactly one new directory (timestamped) plus the .tar.gz. Re-running just
#   produces a new dated postmortem. Old postmortems are never touched.
#
# Flags:
#   -OutputDir <p>        Where to drop the postmortem dir + tarball.
#                         Default: 10-RECEIPTS/postmortems/
#   -ReceiptsPerDir N     How many newest receipts to copy per subdir. Default: 5.
#   -EventLogHours N      Hours of Event Log history to capture. Default: 2.
#   -LogTailLines N       How many lines to keep from the tail of each daemon log.
#                         Default: 2000. Set to 0 to copy whole files.
#   -NoArchive            Skip the .tar.gz step (leave a plain dir on disk).
#   -Quiet                Suppress per-step logs (final summary still prints).
#
# Exit codes (honest):
#   0  Postmortem assembled. Tarball written (unless -NoArchive). Operator
#      can ship it. THIS DOES NOT MEAN THE SYSTEM IS HEALTHY -- it means the
#      collector itself succeeded.
#   1  Postmortem assembled, but ONE OR MORE collectors failed (e.g. no
#      runtime-logs dir). The tarball still exists; INDEX.md names the gaps.
#   2  Fatal: cannot write OutputDir, cannot resolve Orange5 root.

[CmdletBinding()]
param(
  [string]$OutputDir,
  [int]$ReceiptsPerDir = 5,
  [int]$EventLogHours  = 2,
  [int]$LogTailLines   = 2000,
  [switch]$NoArchive,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Paths (absolute, never inferred from a moving cwd)
# ---------------------------------------------------------------------------

$SCRIPT_DIR    = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_ROOT     = Split-Path -Parent (Split-Path -Parent $SCRIPT_DIR)   # C:\AtomEons\Orange5
$ORANGE5_ROOT  = $REPO_ROOT
$RECEIPTS_ROOT = Join-Path $ORANGE5_ROOT "10-RECEIPTS"
$RUNTIME_LOGS  = Join-Path $RECEIPTS_ROOT "runtime-logs"

if (-not $OutputDir -or $OutputDir.Trim() -eq "") {
  $OutputDir = Join-Path $RECEIPTS_ROOT "postmortems"
}

$RUN_STAMP   = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$BUNDLE_NAME = "postmortem-$RUN_STAMP"
$BUNDLE_DIR  = Join-Path $OutputDir $BUNDLE_NAME
$ARCHIVE_TGZ = Join-Path $OutputDir "$BUNDLE_NAME.tar.gz"

# Daemon contract -- mirrors install.ps1's $DAEMONS so log filenames stay aligned.
# The runtime-logs directory uses arbitrary naming (e.g. orangellm-1337.*),
# so we capture EVERY file in runtime-logs/ rather than name-matching.
$DAEMON_PORTS = @(1337, 7430, 7450, 7460)
$DAEMON_NAMES = @("gateway-orangellm", "hermes", "nine-gate-stack", "guardrails-27")

# Secrets we will NEVER write to disk in the postmortem (substring match,
# case-insensitive). Found values become "<REDACTED>" in env.txt.
$SECRET_PATTERNS = @(
  "SECRET", "TOKEN", "API_KEY", "APIKEY", "PASSWORD", "PASSWD",
  "PRIVATE_KEY", "AUTH", "BEARER", "SESSION_KEY", "WEBHOOK"
)

# ---------------------------------------------------------------------------
# Collector tally (each step records GREEN / RED / SKIP)
# ---------------------------------------------------------------------------

$RUN_START = Get-Date
$STEPS     = New-Object System.Collections.ArrayList
$LOG_LINES = New-Object System.Collections.ArrayList

function Log {
  param([string]$Level, [string]$Msg)
  $ts = Get-Date -Format "HH:mm:ss"
  $line = "[{0}] [{1}] {2}" -f $ts, $Level, $Msg
  [void]$LOG_LINES.Add($line)
  if ($Quiet) { return }
  $color = switch ($Level) {
    "GREEN"  { "Green" }
    "RED"    { "Red" }
    "YELLOW" { "Yellow" }
    "INFO"   { "Cyan" }
    "SKIP"   { "DarkGray" }
    default  { "Gray" }
  }
  Write-Host $line -ForegroundColor $color
}

function Add-Step {
  param([string]$Name, [string]$Status, [string]$Detail = "")
  [void]$STEPS.Add([pscustomobject]@{
    Name   = $Name
    Status = $Status
    Detail = $Detail
    At     = (Get-Date -Format "HH:mm:ss")
  })
  Log $Status ("{0} {1}" -f $Name, $(if ($Detail) { "-- $Detail" } else { "" }))
}

# ---------------------------------------------------------------------------
# Fatal pre-flight
# ---------------------------------------------------------------------------

if (-not (Test-Path $ORANGE5_ROOT)) {
  Write-Host "FATAL: Orange5 root not found: $ORANGE5_ROOT" -ForegroundColor Red
  exit 2
}

try {
  if (-not (Test-Path $OutputDir))  { [void](New-Item -ItemType Directory -Path $OutputDir  -Force) }
  if (-not (Test-Path $BUNDLE_DIR)) { [void](New-Item -ItemType Directory -Path $BUNDLE_DIR -Force) }
} catch {
  Write-Host "FATAL: cannot create postmortem dir '$BUNDLE_DIR': $($_.Exception.Message)" -ForegroundColor Red
  exit 2
}

Log "INFO" ("orange5 root : {0}" -f $ORANGE5_ROOT)
Log "INFO" ("bundle dir   : {0}" -f $BUNDLE_DIR)
Log "INFO" ("archive      : {0}" -f $(if ($NoArchive) { "(skipped)" } else { $ARCHIVE_TGZ }))

# ---------------------------------------------------------------------------
# Helper: safe write of a text artifact under $BUNDLE_DIR
# ---------------------------------------------------------------------------

function Write-Artifact {
  param([string]$RelPath, [string]$Body)
  $full = Join-Path $BUNDLE_DIR $RelPath
  $parent = Split-Path -Parent $full
  if (-not (Test-Path $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($full, $Body, $enc)
  return $full
}

# Helper: copy a single file into the bundle (with optional tail truncation).
function Copy-IntoBundle {
  param(
    [string]$Source,
    [string]$RelDest,
    [int]$TailLines = 0
  )
  $full = Join-Path $BUNDLE_DIR $RelDest
  $parent = Split-Path -Parent $full
  if (-not (Test-Path $parent)) { [void](New-Item -ItemType Directory -Path $parent -Force) }
  if ($TailLines -gt 0) {
    # Tail the file (cheap for multi-megabyte logs; full copy would bloat the bundle).
    # Get-Content returns $null on an empty file; coerce to an empty string so
    # WriteAllLines never sees null contents (strict-mode trap).
    $tail = Get-Content -LiteralPath $Source -Tail $TailLines -ErrorAction Stop
    if ($null -eq $tail) { $tail = @() }
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllLines($full, [string[]]@($tail), $enc)
  } else {
    Copy-Item -LiteralPath $Source -Destination $full -Force
  }
  return $full
}

# ---------------------------------------------------------------------------
# Collector 1 -- daemon runtime logs
# ---------------------------------------------------------------------------

function Collect-DaemonLogs {
  if (-not (Test-Path $RUNTIME_LOGS)) {
    Add-Step "daemon-logs" "RED" "no runtime-logs dir at $RUNTIME_LOGS"
    return
  }
  $logs = @(Get-ChildItem -Path $RUNTIME_LOGS -File -ErrorAction SilentlyContinue)
  if ($logs.Count -eq 0) {
    Add-Step "daemon-logs" "YELLOW" "runtime-logs dir is empty"
    return
  }
  $count = 0
  foreach ($f in $logs) {
    try {
      $tailArg = if ($LogTailLines -gt 0) { $LogTailLines } else { 0 }
      [void](Copy-IntoBundle -Source $f.FullName -RelDest "daemon-logs/$($f.Name)" -TailLines $tailArg)
      $count++
    } catch {
      Log "RED" "could not copy $($f.FullName): $($_.Exception.Message)"
    }
  }
  Add-Step "daemon-logs" "GREEN" ("copied {0} file(s), tail={1} lines" -f $count, $LogTailLines)
}

# ---------------------------------------------------------------------------
# Collector 2 -- last N receipts from every receipt subdir
# ---------------------------------------------------------------------------

function Collect-LastReceipts {
  if (-not (Test-Path $RECEIPTS_ROOT)) {
    Add-Step "receipts" "RED" "no 10-RECEIPTS dir"
    return
  }
  $subdirs = Get-ChildItem -Path $RECEIPTS_ROOT -Directory -ErrorAction SilentlyContinue
  if (-not $subdirs) {
    Add-Step "receipts" "YELLOW" "10-RECEIPTS has no subdirs"
    return
  }
  $totalCopied = 0
  $subdirsCovered = 0
  foreach ($sd in $subdirs) {
    # Skip the postmortems dir itself -- we don't recurse into our own output.
    if ($sd.FullName -eq $OutputDir) { continue }
    if ($sd.Name -eq "postmortems")  { continue }
    # Skip runtime-logs -- already collected by Collect-DaemonLogs above.
    if ($sd.Name -eq "runtime-logs") { continue }

    # Force-array (@(...)) so a single-item result still has .Count under strict mode.
    $files = @(Get-ChildItem -Path $sd.FullName -File -ErrorAction SilentlyContinue |
               Sort-Object LastWriteTime -Descending |
               Select-Object -First $ReceiptsPerDir)
    if ($files.Count -eq 0) { continue }
    $subdirsCovered++
    foreach ($f in $files) {
      try {
        [void](Copy-IntoBundle -Source $f.FullName -RelDest "receipts/$($sd.Name)/$($f.Name)")
        $totalCopied++
      } catch {
        Log "RED" "could not copy receipt $($f.FullName): $($_.Exception.Message)"
      }
    }
  }
  Add-Step "receipts" "GREEN" ("copied {0} file(s) across {1} subdir(s)" -f $totalCopied, $subdirsCovered)
}

# ---------------------------------------------------------------------------
# Collector 3 -- env state (with secret redaction)
# ---------------------------------------------------------------------------

function Collect-EnvState {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Environment snapshot -- $RUN_STAMP")
    [void]$lines.Add("# Secrets matching: " + ($SECRET_PATTERNS -join ", ") + " are redacted.")
    [void]$lines.Add("")
    [void]$lines.Add("## Host")
    [void]$lines.Add("computer-name : $env:COMPUTERNAME")
    [void]$lines.Add("user-name     : $env:USERNAME")
    [void]$lines.Add("processor     : $env:PROCESSOR_IDENTIFIER ($env:NUMBER_OF_PROCESSORS cores)")
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if ($os) {
      [void]$lines.Add("os            : $($os.Caption) build $($os.BuildNumber)")
      [void]$lines.Add("os-arch       : $($os.OSArchitecture)")
      [void]$lines.Add("ram-total-gb  : {0:N1}" -f ($os.TotalVisibleMemorySize / 1MB))
      [void]$lines.Add("ram-free-gb   : {0:N1}" -f ($os.FreePhysicalMemory / 1MB))
      [void]$lines.Add("last-boot     : $($os.LastBootUpTime)")
    }
    [void]$lines.Add("psversion     : $($PSVersionTable.PSVersion)")
    [void]$lines.Add("psedition     : $($PSVersionTable.PSEdition)")
    [void]$lines.Add("")

    [void]$lines.Add("## PATH (one per line)")
    foreach ($p in ($env:Path -split ';')) {
      if ($p.Trim()) { [void]$lines.Add($p) }
    }
    [void]$lines.Add("")

    [void]$lines.Add("## Environment variables (redacted)")
    $envVars = Get-ChildItem Env: | Sort-Object Name
    foreach ($ev in $envVars) {
      $name  = $ev.Name
      $value = $ev.Value
      $redact = $false
      foreach ($pat in $SECRET_PATTERNS) {
        if ($name -imatch $pat) { $redact = $true; break }
      }
      if ($redact) {
        $len = if ($value) { $value.Length } else { 0 }
        [void]$lines.Add("$name = <REDACTED len=$len>")
      } else {
        [void]$lines.Add("$name = $value")
      }
    }

    [void](Write-Artifact -RelPath "env.txt" -Body (($lines -join "`r`n")))
    Add-Step "env-state" "GREEN" "host + PATH + env (secrets redacted)"
  } catch {
    Add-Step "env-state" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 4 -- port snapshot
# ---------------------------------------------------------------------------

function Collect-PortSnapshot {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Port snapshot -- $RUN_STAMP")
    [void]$lines.Add("")
    [void]$lines.Add("## Orange5 daemon ports (1337 gateway, 7430 hermes, 7450 nine-gate, 7460 guardrails)")
    foreach ($port in $DAEMON_PORTS) {
      [void]$lines.Add("")
      [void]$lines.Add("### Port $port")
      try {
        $conns = @(Get-NetTCPConnection -LocalPort $port -ErrorAction Stop)
        if ($conns.Count -gt 0) {
          foreach ($c in $conns) {
            $procName = ""
            try {
              $proc = Get-Process -Id $c.OwningProcess -ErrorAction Stop
              $procName = "$($proc.ProcessName) (pid=$($proc.Id))"
            } catch { $procName = "pid=$($c.OwningProcess) (no proc)" }
            [void]$lines.Add(("  state={0,-12} local={1}:{2}  remote={3}:{4}  owner={5}" -f `
              $c.State, $c.LocalAddress, $c.LocalPort, $c.RemoteAddress, $c.RemotePort, $procName))
          }
        } else {
          [void]$lines.Add("  (no listener / no connections)")
        }
      } catch {
        [void]$lines.Add("  Get-NetTCPConnection failed: $($_.Exception.Message)")
      }
    }
    [void]$lines.Add("")
    [void]$lines.Add("## All LISTEN sockets on this host")
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
                     Sort-Object LocalPort)
      foreach ($l in $listeners) {
        $procName = ""
        try {
          $proc = Get-Process -Id $l.OwningProcess -ErrorAction Stop
          $procName = "$($proc.ProcessName) (pid=$($proc.Id))"
        } catch { $procName = "pid=$($l.OwningProcess)" }
        [void]$lines.Add(("  {0}:{1,-6}  {2}" -f $l.LocalAddress, $l.LocalPort, $procName))
      }
    } catch {
      [void]$lines.Add("  Get-NetTCPConnection -State Listen failed: $($_.Exception.Message)")
    }
    [void](Write-Artifact -RelPath "ports.txt" -Body (($lines -join "`r`n")))
    Add-Step "ports" "GREEN" "$($DAEMON_PORTS.Count) daemon ports + full LISTEN sweep"
  } catch {
    Add-Step "ports" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 5 -- npm install output (cached debug log + ls of top-level deps)
# ---------------------------------------------------------------------------

function Collect-NpmState {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# npm state -- $RUN_STAMP")
    [void]$lines.Add("# This file does NOT run 'npm install'. It reports the install that already happened.")
    [void]$lines.Add("")

    # Cached debug log from the most recent failed install (npm writes these
    # automatically under %LOCALAPPDATA%\npm-cache\_logs on Windows).
    $npmCache = Join-Path $env:LOCALAPPDATA "npm-cache\_logs"
    [void]$lines.Add("## Most-recent npm-debug logs (from $npmCache)")
    if (Test-Path $npmCache) {
      $debugLogs = @(Get-ChildItem -Path $npmCache -File -ErrorAction SilentlyContinue |
                     Sort-Object LastWriteTime -Descending |
                     Select-Object -First 3)
      if ($debugLogs.Count -gt 0) {
        foreach ($dl in $debugLogs) {
          [void]$lines.Add("- $($dl.Name)  ($($dl.LastWriteTime))  $($dl.Length) bytes")
          try {
            [void](Copy-IntoBundle -Source $dl.FullName -RelDest "npm-cache/$($dl.Name)" -TailLines 1000)
          } catch {
            [void]$lines.Add("  copy failed: $($_.Exception.Message)")
          }
        }
      } else {
        [void]$lines.Add("(npm cache dir exists but has no debug logs)")
      }
    } else {
      [void]$lines.Add("(npm cache dir not found -- npm may never have run on this host)")
    }
    [void]$lines.Add("")

    # Top-level npm ls for every package.json under Orange5 root (depth 0 = no
    # tree explosion, but tells us what each subproject thinks it has).
    [void]$lines.Add("## npm ls --depth=0 per package.json")
    $pkgJsons = @(Get-ChildItem -Path $ORANGE5_ROOT -Recurse -File -Filter "package.json" `
                    -ErrorAction SilentlyContinue |
                  Where-Object {
                    $_.FullName -notmatch '\\node_modules\\' -and
                    $_.FullName -notmatch '\\19-ARCHIVE\\'   -and
                    $_.FullName -notmatch '\\18-HELD\\'
                  })
    if ($pkgJsons.Count -gt 0) {
      [void]$lines.Add("(found $($pkgJsons.Count) package.json file(s))")
      $hasNpm = $null -ne (Get-Command npm -ErrorAction SilentlyContinue)
      if (-not $hasNpm) {
        [void]$lines.Add("(npm not on PATH; skipping per-pkg ls)")
      } else {
        # Bound each npm ls to 20s. A stalled npm (network probe, lockfile
        # contention) must not hang the whole postmortem.
        foreach ($pj in $pkgJsons) {
          $dir = Split-Path -Parent $pj.FullName
          $rel = $pj.FullName.Substring($ORANGE5_ROOT.Length).TrimStart('\','/')
          [void]$lines.Add("")
          [void]$lines.Add("### $rel")
          # Use the .Arguments string property (Win PS 5.1 compatible -- the
          # .ArgumentList collection is PS 7+ / .NET 5+ only). Quote the prefix
          # path because Windows directory paths often contain spaces.
          $psi = New-Object System.Diagnostics.ProcessStartInfo
          $psi.FileName               = "npm"
          $psi.Arguments              = ('ls --depth=0 --prefix "{0}"' -f $dir)
          $psi.UseShellExecute        = $false
          $psi.RedirectStandardOutput = $true
          $psi.RedirectStandardError  = $true
          $psi.CreateNoWindow         = $true
          $p = New-Object System.Diagnostics.Process
          $p.StartInfo = $psi
          try {
            [void]$p.Start()
            if ($p.WaitForExit(20000)) {
              $stdout = $p.StandardOutput.ReadToEnd()
              $stderr = $p.StandardError.ReadToEnd()
              if ($stdout) { [void]$lines.Add($stdout.TrimEnd()) }
              if ($stderr) { [void]$lines.Add("(stderr) " + $stderr.TrimEnd()) }
            } else {
              try { $p.Kill() } catch { }
              [void]$lines.Add("(npm ls TIMEOUT after 20s)")
            }
          } catch {
            [void]$lines.Add("npm ls failed: $($_.Exception.Message)")
          }
        }
      }
    } else {
      [void]$lines.Add("(no package.json found outside ignored roots)")
    }
    [void](Write-Artifact -RelPath "npm.txt" -Body (($lines -join "`r`n")))
    Add-Step "npm-state" "GREEN" "cached debug logs + npm ls per package.json"
  } catch {
    Add-Step "npm-state" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 6 -- process + service status
# ---------------------------------------------------------------------------

function Collect-ProcessState {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Process + service state -- $RUN_STAMP")
    [void]$lines.Add("")

    # Processes that could be Orange5 daemons (node, bun, python) plus the
    # local-AI processes that the bootstrap depends on.
    [void]$lines.Add("## Relevant processes (node, bun, python, ollama, docker)")
    $procNames = @("node","bun","python","ollama","Docker Desktop","com.docker.backend","dockerd")
    foreach ($pn in $procNames) {
      $procs = @(Get-Process -Name $pn -ErrorAction SilentlyContinue)
      if ($procs.Count -gt 0) {
        foreach ($p in $procs) {
          $mb = [Math]::Round($p.WorkingSet64 / 1MB, 1)
          $cmdLine = ""
          try {
            $ci = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop
            if ($ci -and $ci.CommandLine) { $cmdLine = $ci.CommandLine }
          } catch { }
          [void]$lines.Add(("  {0,-22} pid={1,-6} mem={2,7} MB  start={3}  cmd={4}" -f `
            $p.ProcessName, $p.Id, $mb, $p.StartTime, $cmdLine))
        }
      } else {
        [void]$lines.Add(("  {0,-22} (not running)" -f $pn))
      }
    }
    [void]$lines.Add("")

    # Windows services that the local-AI stack uses. Closest analog to
    # `systemctl status` on Linux.
    [void]$lines.Add("## Relevant services (Ollama, Docker, com.docker.service)")
    $svcNames = @("Ollama","com.docker.service","Docker Desktop Service","Docker")
    foreach ($svc in $svcNames) {
      $s = Get-Service -Name $svc -ErrorAction SilentlyContinue
      if ($s) {
        [void]$lines.Add(("  {0,-30} status={1} starttype={2}" -f $s.Name, $s.Status, $s.StartType))
      } else {
        [void]$lines.Add(("  {0,-30} (not installed)" -f $svc))
      }
    }
    [void]$lines.Add("")

    # WSL state -- Docker Desktop runs Linux containers via WSL2 on Windows;
    # a stalled WSL is a common silent killer of the install path.
    [void]$lines.Add("## WSL distros")
    try {
      $wslOut = & wsl --list --verbose 2>&1 | Out-String
      [void]$lines.Add($wslOut.TrimEnd())
    } catch {
      [void]$lines.Add("(wsl --list failed: $($_.Exception.Message))")
    }

    [void](Write-Artifact -RelPath "processes.txt" -Body (($lines -join "`r`n")))
    Add-Step "process-state" "GREEN" "node/bun/python/ollama/docker + services + WSL"
  } catch {
    Add-Step "process-state" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 7 -- tool versions (re-verify because env may have drifted)
# ---------------------------------------------------------------------------

function Collect-ToolVersions {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Tool versions -- $RUN_STAMP")
    [void]$lines.Add("# Each row is a real subprocess call, not a path-existence guess.")
    [void]$lines.Add("")
    $probes = @(
      @{ Name="node";   Args=@("--version") }
      @{ Name="bun";    Args=@("--version") }
      @{ Name="python"; Args=@("--version") }
      @{ Name="git";    Args=@("--version") }
      @{ Name="gh";     Args=@("--version") }
      @{ Name="docker"; Args=@("--version") }
      @{ Name="ollama"; Args=@("--version") }
      @{ Name="npm";    Args=@("--version") }
      @{ Name="pwsh";   Args=@("--version") }
    )
    foreach ($p in $probes) {
      $cmd = Get-Command $p.Name -ErrorAction SilentlyContinue
      if (-not $cmd) {
        [void]$lines.Add(("{0,-10} : (not on PATH)" -f $p.Name))
        continue
      }
      try {
        $out = & $cmd.Source @($p.Args) 2>&1 | Out-String
        $first = (($out -split "`n") | Where-Object { $_.Trim() })[0]
        [void]$lines.Add(("{0,-10} : {1}  ({2})" -f $p.Name, $first, $cmd.Source))
      } catch {
        [void]$lines.Add(("{0,-10} : error: {1}" -f $p.Name, $_.Exception.Message))
      }
    }
    [void](Write-Artifact -RelPath "tools.txt" -Body (($lines -join "`r`n")))
    Add-Step "tool-versions" "GREEN" "$($probes.Count) tool probes"
  } catch {
    Add-Step "tool-versions" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 8 -- disk + free space
# ---------------------------------------------------------------------------

function Collect-DiskState {
  try {
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Disk state -- $RUN_STAMP")
    [void]$lines.Add("")
    $vols = Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue |
            Where-Object DriveType -eq 3
    foreach ($v in $vols) {
      $sizeGB = [Math]::Round($v.Size / 1GB, 1)
      $freeGB = [Math]::Round($v.FreeSpace / 1GB, 1)
      $pct    = if ($v.Size -gt 0) { [Math]::Round(100.0 * $v.FreeSpace / $v.Size, 1) } else { 0 }
      [void]$lines.Add(("{0}  size={1,7} GB  free={2,7} GB  free%={3,5}  fs={4}" -f `
        $v.DeviceID, $sizeGB, $freeGB, $pct, $v.FileSystem))
    }
    [void]$lines.Add("")
    [void]$lines.Add("## Orange5 tree size (recursive)")
    try {
      $sum = (Get-ChildItem -Path $ORANGE5_ROOT -Recurse -File -Force -ErrorAction SilentlyContinue |
              Measure-Object -Property Length -Sum).Sum
      $gb = if ($sum) { [Math]::Round($sum / 1GB, 2) } else { 0 }
      [void]$lines.Add("$ORANGE5_ROOT total = $gb GB")
    } catch {
      [void]$lines.Add("sizing failed: $($_.Exception.Message)")
    }
    [void](Write-Artifact -RelPath "disk.txt" -Body (($lines -join "`r`n")))
    Add-Step "disk-state" "GREEN" "volumes + Orange5 tree size"
  } catch {
    Add-Step "disk-state" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Collector 9 -- recent Event Log errors (Application + System)
# ---------------------------------------------------------------------------

function Collect-EventLog {
  try {
    $since = (Get-Date).AddHours(-1 * $EventLogHours)
    $lines = New-Object System.Collections.ArrayList
    [void]$lines.Add("# Windows Event Log errors -- since $($since.ToString('s')) ($EventLogHours h)")
    [void]$lines.Add("# Level <= 2 (Error / Critical).")
    [void]$lines.Add("")
    foreach ($logName in @("Application","System")) {
      [void]$lines.Add("## $logName")
      try {
        $events = @(Get-WinEvent -FilterHashtable @{
          LogName   = $logName
          Level     = @(1,2)             # 1=Critical, 2=Error
          StartTime = $since
        } -ErrorAction Stop |
          Select-Object -First 100)
        if ($events.Count -gt 0) {
          foreach ($e in $events) {
            $msg = if ($e.Message) { ($e.Message -split "`n")[0] } else { "" }
            [void]$lines.Add(("{0}  level={1}  src={2,-25} id={3,-6} : {4}" -f `
              $e.TimeCreated, $e.LevelDisplayName, $e.ProviderName, $e.Id, $msg))
          }
        } else {
          [void]$lines.Add("(no errors)")
        }
      } catch {
        [void]$lines.Add("Get-WinEvent failed: $($_.Exception.Message)")
      }
      [void]$lines.Add("")
    }
    [void](Write-Artifact -RelPath "eventlog.txt" -Body (($lines -join "`r`n")))
    Add-Step "eventlog" "GREEN" "Application + System (last $EventLogHours h)"
  } catch {
    Add-Step "eventlog" "RED" $_.Exception.Message
  }
}

# ---------------------------------------------------------------------------
# Run every collector. Each one captures its own failure -- one broken
# collector never silently kills the bundle.
# ---------------------------------------------------------------------------

Collect-DaemonLogs
Collect-LastReceipts
Collect-EnvState
Collect-PortSnapshot
Collect-NpmState
Collect-ProcessState
Collect-ToolVersions
Collect-DiskState
Collect-EventLog

# ---------------------------------------------------------------------------
# INDEX.md -- narrative + sha256 of every collected file
# ---------------------------------------------------------------------------

$RUN_END   = Get-Date
$TotalSec  = [Math]::Round(($RUN_END - $RUN_START).TotalSeconds, 2)
$Greens    = (@($STEPS | Where-Object Status -eq "GREEN")).Count
$Yellows   = (@($STEPS | Where-Object Status -eq "YELLOW")).Count
$Reds      = (@($STEPS | Where-Object Status -eq "RED")).Count
$Skips     = (@($STEPS | Where-Object Status -eq "SKIP")).Count

# Walk every file in the bundle and hash it.
$bundleFiles = @(Get-ChildItem -Path $BUNDLE_DIR -Recurse -File -ErrorAction SilentlyContinue |
                 Sort-Object FullName)

$idx = New-Object System.Collections.ArrayList
[void]$idx.Add("# Orange5 postmortem -- $RUN_STAMP")
[void]$idx.Add("")
[void]$idx.Add("- doctrine     : Mom's Law -- forensic truth, no theater")
[void]$idx.Add("- collector    : scripts/repro/postmortem.ps1")
[void]$idx.Add("- orange5 root : $ORANGE5_ROOT")
[void]$idx.Add("- host         : $env:COMPUTERNAME  user=$env:USERNAME")
[void]$idx.Add("- start        : $($RUN_START.ToString('o'))")
[void]$idx.Add("- end          : $($RUN_END.ToString('o'))")
[void]$idx.Add("- total        : $TotalSec s")
[void]$idx.Add("- tally        : GREEN=$Greens YELLOW=$Yellows RED=$Reds SKIP=$Skips")
[void]$idx.Add("")
[void]$idx.Add("## What this bundle is")
[void]$idx.Add("")
[void]$idx.Add("This is a frozen snapshot of the Orange5 backend's environment, daemon")
[void]$idx.Add("logs, recent receipts, ports, processes, and tool versions at the moment")
[void]$idx.Add("the operator ran postmortem.ps1. It is meant to be shipped (the .tar.gz")
[void]$idx.Add("at the parent dir level) to a teammate or future-Atom for diagnosis.")
[void]$idx.Add("")
[void]$idx.Add("Bundle GREEN here means **the collector ran cleanly**, not that the")
[void]$idx.Add("system is healthy. Look at receipts/orange5-bootstrap/ and")
[void]$idx.Add("receipts/orange5-verify/ for the actual health verdict.")
[void]$idx.Add("")
[void]$idx.Add("## Where to start reading")
[void]$idx.Add("")
[void]$idx.Add("1. **receipts/orange5-bootstrap/**  -- toolchain install + verify history")
[void]$idx.Add("2. **receipts/orange5-verify/**     -- smoke + guardrails + red-team verdicts")
[void]$idx.Add("3. **daemon-logs/**                 -- per-port runtime stdout/stderr tails")
[void]$idx.Add("4. **ports.txt**                    -- who is actually listening where")
[void]$idx.Add("5. **processes.txt**                -- node/bun/python/ollama/docker + WSL")
[void]$idx.Add("6. **tools.txt**                    -- live tool versions on PATH right now")
[void]$idx.Add("7. **env.txt**                      -- PATH + redacted env vars")
[void]$idx.Add("8. **npm.txt**                      -- cached npm-debug + npm ls per pkg")
[void]$idx.Add("9. **eventlog.txt**                 -- last $EventLogHours h of Windows errors")
[void]$idx.Add("10. **disk.txt**                    -- free space; Orange5 tree footprint")
[void]$idx.Add("")
[void]$idx.Add("## Collector tally")
[void]$idx.Add("")
[void]$idx.Add("| collector | status | detail |")
[void]$idx.Add("|-----------|--------|--------|")
foreach ($s in $STEPS) {
  $d = ($s.Detail -replace '\|','\|' -replace "`r?`n"," ")
  [void]$idx.Add("| $($s.Name) | $($s.Status) | $d |")
}
[void]$idx.Add("")
[void]$idx.Add("## File manifest (sha256)")
[void]$idx.Add("")
[void]$idx.Add("| file | bytes | sha256 |")
[void]$idx.Add("|------|-------|--------|")
foreach ($f in $bundleFiles) {
  $rel = $f.FullName.Substring($BUNDLE_DIR.Length).TrimStart('\','/')
  $hash = ""
  try {
    $hash = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  } catch {
    $hash = "hash-failed: $($_.Exception.Message)"
  }
  [void]$idx.Add("| $rel | $($f.Length) | $hash |")
}
[void]$idx.Add("")
[void]$idx.Add("## Log")
[void]$idx.Add("")
[void]$idx.Add('```')
foreach ($l in $LOG_LINES) { [void]$idx.Add($l) }
[void]$idx.Add('```')

[void](Write-Artifact -RelPath "INDEX.md" -Body (($idx -join "`r`n")))
Log "INFO" "INDEX.md written"

# ---------------------------------------------------------------------------
# Archive (tar.gz). Uses tar.exe, which has shipped with Windows 10/11
# since build 17063. If it is missing we still leave the dir intact.
# ---------------------------------------------------------------------------

$archiveStatus = "SKIP"
$archiveDetail = ""
if (-not $NoArchive) {
  $tar = Get-Command tar -ErrorAction SilentlyContinue
  if (-not $tar) {
    $archiveStatus = "RED"
    $archiveDetail = "tar.exe not found on PATH; left raw dir at $BUNDLE_DIR"
    Log "RED" $archiveDetail
  } else {
    try {
      $parentDir = Split-Path -Parent $BUNDLE_DIR
      $bundleLeaf = Split-Path -Leaf  $BUNDLE_DIR
      # -C <parent> ensures tar stores relative paths (postmortem-<ts>/...)
      # rather than the full C:\AtomEons\... prefix, which would surprise any
      # recipient extracting on a different machine.
      # --force-local is required on Windows tar.exe: without it, any path
      # containing a colon (C:\) is parsed as rsh-style host:path syntax and
      # the operation fails with "Cannot connect to C: resolve failed".
      $args = @("--force-local", "-czf", $ARCHIVE_TGZ, "-C", $parentDir, $bundleLeaf)
      & tar @args
      if ($LASTEXITCODE -ne 0) {
        $archiveStatus = "RED"
        $archiveDetail = "tar exit=$LASTEXITCODE"
        Log "RED" $archiveDetail
      } else {
        $archiveStatus = "GREEN"
        $size = (Get-Item -LiteralPath $ARCHIVE_TGZ).Length
        $archiveDetail = "$ARCHIVE_TGZ ($size bytes)"
        Log "GREEN" "archive: $archiveDetail"
      }
    } catch {
      $archiveStatus = "RED"
      $archiveDetail = "tar failed: $($_.Exception.Message)"
      Log "RED" $archiveDetail
    }
  }
} else {
  Log "INFO" "-NoArchive set; leaving raw dir at $BUNDLE_DIR"
}
Add-Step "archive" $archiveStatus $archiveDetail

# ---------------------------------------------------------------------------
# Final summary
# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "==================== Orange5 postmortem summary ====================" -ForegroundColor Cyan
$STEPS | Format-Table Name, Status, Detail -AutoSize
Write-Host ("Wall clock : {0}s" -f $TotalSec) -ForegroundColor Cyan
Write-Host ("Bundle dir : {0}" -f $BUNDLE_DIR) -ForegroundColor Cyan
if (-not $NoArchive -and (Test-Path $ARCHIVE_TGZ)) {
  Write-Host ("Archive    : {0}" -f $ARCHIVE_TGZ) -ForegroundColor Cyan
  Write-Host ("Ship this file to your teammate / future-Atom.") -ForegroundColor Green
}
Write-Host "====================================================================" -ForegroundColor Cyan

# Exit code policy:
#   0 -- every collector GREEN. (Collector success; NOT system health.)
#   1 -- at least one collector RED. Bundle is still on disk.
if ($Reds -gt 0) { exit 1 }
exit 0
