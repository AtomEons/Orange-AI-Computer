# install.ps1
# Orange5 sovereign-reproducibility installer + boot-validation.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- full effort, no theater, no silent fallback. Every
#   phase is timed. Every daemon is probed at its real /healthz. The receipt
#   prints honest wall-clock truth, not a slogan. If anything is RED, the
#   exit code says so.
#
# Mission: Sovereign reproducibility. Any operator -- or future-Atom on a
#   fresh Windows 11 box -- can:
#     1. run bootstrap.ps1   (toolchain on the metal)
#     2. run install.ps1     (this script: unzip Orange5 -> wire -> boot)
#   ...and reach a state where all four backend daemons answer their
#   /healthz, total wall-clock under 30 minutes from a clean machine.
#
# This script is step 2. It assumes bootstrap.ps1 has already verified
# Node 20+, Bun 1.1+, Python 3.11+, Ollama, Docker, Git, gh are on PATH.
#
# Phases:
#   1. Pre-flight    -- confirm required runtimes (node, bun, pwsh) on PATH.
#   2. Locate zip    -- auto-discover orange5-v*.zip in dist/ or $ScriptDir,
#                       or accept -ZipPath. The zip is the wave3-21
#                       distributable produced by dist/pack.ps1.
#   3. Verify+extract -- delegate to dist/install.ps1 (single source of truth
#                        for SHA-256 verify, atomic extract, per-file audit).
#                        Output: a freshly extracted Orange5 tree.
#   4. Wave12 wire-up -- run scripts/wave12-wire-up.ps1 -Force inside the
#                        extracted tree. This installs npm deps, splices
#                        gateway routes, boots gateway on :1337, runs the
#                        subsystem smoke battery.
#   5. Boot daemons  -- start Hermes (:7430), 9-Gate (:7450), Guardrails
#                       (:7460). Gateway (:1337) is already up from phase 4.
#   6. Probe /healthz -- bounded wait on each daemon. Real HTTP probe with
#                        per-daemon timing. No "if the process is running we
#                        call it green" theater -- only HTTP 200 counts.
#   7. Receipt       -- markdown receipt at 10-RECEIPTS/orange5-bootstrap/
#                       <ts>-install.md. Tally + per-phase wall-clock + the
#                       four /healthz bodies. Total time must be < $BUDGET.
#
# Flags:
#   -ZipPath <p>      Path to orange5-v*.zip. Default: auto-discover.
#   -HashPath <p>     Path to orange5-v*.sha256 manifest. Default: derive.
#   -Destination <p>  Parent dir for extracted tree. Default: C:\AtomEons
#                     (so the install lands at C:\AtomEons\Orange5\<release>\,
#                     which matches what wave12-wire-up.ps1 expects).
#   -Force            Allow overwriting an existing install at Destination
#                     and force gateway restart in wave12. Required after
#                     the first successful install on a given box.
#   -DryRun           Walk every phase without state change. Verification
#                     probes still run against whatever is already up.
#   -SkipExtract      Skip phase 3 (assume tree already at $InstallRoot).
#                     Useful for re-running boot validation only.
#   -SkipWave12       Skip phase 4. Phase 5/6 still run, which is the
#                     "boot the daemons against an already-wired tree" lane.
#   -SkipDaemonBoot   Skip phase 5 (don't start daemons). Phase 6 still
#                     probes -- so this is the "are they already up?" check.
#   -BudgetMinutes N  Total wall-clock budget. Default: 30. RED if exceeded.
#   -ReceiptDir <p>   Override receipt directory.
#
# Exit codes:
#   0  All four daemons answered /healthz with 200. Wall-clock <= budget.
#   1  One or more RED rows (daemon dead, wave12 failed, budget exceeded).
#      Receipt is still written -- it is the post-mortem.
#   2  Fatal pre-flight (zip missing, dist/install.ps1 missing, cannot
#      write receipt dir).
#   3  Wave12 dry-run / spliced gateway boot failed (non-fatal: install
#      proceeded but the gateway never came green).

[CmdletBinding()]
param(
  [string]$ZipPath,
  [string]$HashPath,
  [string]$Destination = "C:\AtomEons",
  [switch]$Force,
  [switch]$DryRun,
  [switch]$SkipExtract,
  [switch]$SkipWave12,
  [switch]$SkipDaemonBoot,
  [int]$BudgetMinutes = 30,
  [string]$ReceiptDir
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Constants / anchored paths
# ---------------------------------------------------------------------------

$SCRIPT_DIR    = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_ROOT     = Resolve-Path (Join-Path $SCRIPT_DIR "..\..") | Select-Object -ExpandProperty Path
$DIST_DIR      = Join-Path $REPO_ROOT "dist"
$DIST_INSTALL  = Join-Path $DIST_DIR  "install.ps1"

# Where wave12-wire-up.ps1 hard-codes $ORANGE5_ROOT. The extracted tree must
# land here or wave12 will report path-mismatch reds. We honor that contract.
$EXPECTED_ROOT = "C:\AtomEons\Orange5"

# Daemon contract: name, port, healthz URL, launcher metadata.
$DAEMONS = @(
  @{
    Name      = "gateway-orangellm"
    Port      = 1337
    Healthz   = "http://127.0.0.1:1337/healthz"
    BootedBy  = "wave12-wire-up.ps1 phase 3"
    LaunchCmd = $null   # gateway is brought up by wave12, not by us
    Cwd       = $null
  },
  @{
    Name      = "hermes"
    Port      = 7430
    Healthz   = "http://127.0.0.1:7430/healthz"
    BootedBy  = "bun run src/server.mjs"
    LaunchCmd = @{ Exe = "bun"; Args = @("run","src/server.mjs") }
    Cwd       = "08-HERMES"
  },
  @{
    Name      = "nine-gate-stack"
    Port      = 7450
    Healthz   = "http://127.0.0.1:7450/healthz"
    BootedBy  = "bun run server.mjs"
    LaunchCmd = @{ Exe = "bun"; Args = @("run","server.mjs") }
    Cwd       = "04-CONTROL-PLANE\nine-gate-stack"
  },
  @{
    Name      = "guardrails-27"
    Port      = 7460
    Healthz   = "http://127.0.0.1:7460/healthz"
    BootedBy  = "node launch.mjs start"
    LaunchCmd = @{ Exe = "node"; Args = @("launch.mjs","start") }
    Cwd       = "01-DOCTRINE\27-guardrails"
  }
)

# ---------------------------------------------------------------------------
# Receipt scaffolding
# ---------------------------------------------------------------------------

$RUN_START   = Get-Date
$PHASE_TIMES = @{}              # phase name -> seconds
$PHASE_ORDER = New-Object System.Collections.ArrayList
$STEPS       = New-Object System.Collections.ArrayList   # tally rows
$DAEMON_RESULTS = New-Object System.Collections.ArrayList
$LOG_LINES   = New-Object System.Collections.ArrayList

function Log {
  param([string]$Level, [string]$Msg)
  $ts = Get-Date -Format "HH:mm:ss"
  $line = "[{0}] [{1}] {2}" -f $ts, $Level, $Msg
  $color = switch ($Level) {
    "GREEN"  { "Green" }
    "RED"    { "Red" }
    "YELLOW" { "Yellow" }
    "INFO"   { "Cyan" }
    "STEP"   { "Cyan" }
    default  { "Gray" }
  }
  Write-Host $line -ForegroundColor $color
  [void]$LOG_LINES.Add($line)
}

function Banner {
  param([string]$Text)
  Write-Host ""
  Write-Host ("=== {0} ===" -f $Text) -ForegroundColor Cyan
  [void]$LOG_LINES.Add("")
  [void]$LOG_LINES.Add(("=== {0} ===" -f $Text))
}

function Add-Step {
  param([string]$Phase, [string]$Name, [string]$Status, [string]$Detail = "")
  [void]$STEPS.Add([pscustomobject]@{
    Phase  = $Phase
    Name   = $Name
    Status = $Status
    Detail = $Detail
    At     = (Get-Date -Format "HH:mm:ss")
  })
  Log $Status ("[{0}] {1} {2}" -f $Phase, $Name, $(if ($Detail) { "-- $Detail" } else { "" }))
}

function Time-Phase {
  param([string]$Name, [scriptblock]$Block)
  if (-not $PHASE_ORDER.Contains($Name)) { [void]$PHASE_ORDER.Add($Name) }
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    & $Block
  } finally {
    $sw.Stop()
    $PHASE_TIMES[$Name] = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
    Log "INFO" ("phase '{0}' took {1}s" -f $Name, $PHASE_TIMES[$Name])
  }
}

# ---------------------------------------------------------------------------
# PHASE 1 -- pre-flight
# ---------------------------------------------------------------------------

Banner ("Orange5 sovereign-reproducibility install -- budget {0} min" -f $BudgetMinutes)
Log "INFO" ("script dir   : {0}" -f $SCRIPT_DIR)
Log "INFO" ("repo root    : {0}" -f $REPO_ROOT)
Log "INFO" ("destination  : {0}" -f $Destination)
Log "INFO" ("dry-run      : {0}" -f $DryRun)
Log "INFO" ("force        : {0}" -f $Force)

Time-Phase "1-preflight" {
  $missing = @()
  foreach ($exe in @("node","bun","pwsh","powershell")) {
    $cmd = Get-Command $exe -ErrorAction SilentlyContinue
    if (-not $cmd) {
      # pwsh OR powershell is enough; treat them as one slot.
      if ($exe -eq "pwsh") { continue }
      if ($exe -eq "powershell") {
        if (-not (Get-Command "pwsh" -ErrorAction SilentlyContinue)) { $missing += "powershell|pwsh" }
        continue
      }
      $missing += $exe
    }
  }
  if ($missing.Count -gt 0) {
    Add-Step "1" "pre-flight runtimes" "RED" ("missing: {0}" -f ($missing -join ", "))
    Log "RED" "pre-flight FAIL -- run bootstrap.ps1 first"
    exit 2
  }
  Add-Step "1" "pre-flight runtimes" "GREEN" "node, bun, powershell present"

  if (-not (Test-Path $DIST_INSTALL)) {
    Add-Step "1" "dist/install.ps1 present" "RED" $DIST_INSTALL
    Log "RED" ("dist/install.ps1 is the canonical extractor -- not found at {0}" -f $DIST_INSTALL)
    exit 2
  }
  Add-Step "1" "dist/install.ps1 present" "GREEN" $DIST_INSTALL
}

# ---------------------------------------------------------------------------
# PHASE 2 -- locate zip + hash manifest
# ---------------------------------------------------------------------------

Time-Phase "2-locate-zip" {
  if (-not $ZipPath) {
    # Prefer the dist/ directory; the wave3-21 packaging workflow writes
    # orange5-v<NN>-<YYYYMMDD>.zip there alongside the .sha256 manifest.
    $searchDirs = @($DIST_DIR, $SCRIPT_DIR, $REPO_ROOT)
    foreach ($d in $searchDirs) {
      if (-not (Test-Path $d)) { continue }
      $hit = Get-ChildItem -LiteralPath $d -Filter 'orange5-v*.zip' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
      if ($hit) {
        $script:ZipPath = $hit.FullName
        Log "STEP" ("auto-selected zip: {0}" -f $script:ZipPath)
        break
      }
    }
  }
  if (-not $ZipPath -or -not (Test-Path $ZipPath)) {
    if ($SkipExtract) {
      Add-Step "2" "locate zip" "YELLOW" "no zip found, but -SkipExtract set"
    } else {
      Add-Step "2" "locate zip" "RED" "no orange5-v*.zip found; pass -ZipPath or run dist/pack.ps1"
      Log "RED" "cannot proceed without a zip. Either pack one (dist/pack.ps1) or pass -ZipPath."
      exit 2
    }
  } else {
    $ZipPath = (Resolve-Path -LiteralPath $ZipPath).Path
    if (-not $HashPath) {
      $zipBase = [IO.Path]::GetFileNameWithoutExtension($ZipPath)
      $zipDir  = Split-Path -Parent $ZipPath
      if ($zipBase -match '^(orange5-v\d+)-\d{8}$') {
        $script:HashPath = Join-Path $zipDir ("{0}.sha256" -f $Matches[1])
      } else {
        $script:HashPath = Join-Path $zipDir ($zipBase + ".sha256")
      }
    }
    if (-not (Test-Path $HashPath)) {
      Add-Step "2" "hash manifest present" "RED" $HashPath
      exit 2
    }
    Add-Step "2" "locate zip + manifest" "GREEN" ("zip={0} hash={1}" -f (Split-Path -Leaf $ZipPath), (Split-Path -Leaf $HashPath))
  }
}

# Compute the install root the way dist/install.ps1 does so we can find it
# afterward. dist/install.ps1 lands the tree at <Destination>\<release-name>\
# where <release-name> is the zip basename minus .zip.
$ReleaseName = $null
$InstallRoot = $null
if ($ZipPath -and (Test-Path $ZipPath)) {
  $ReleaseName = [IO.Path]::GetFileNameWithoutExtension($ZipPath)
  $InstallRoot = Join-Path $Destination $ReleaseName
} elseif ($SkipExtract) {
  # Assume an existing tree at the canonical root.
  if (Test-Path $EXPECTED_ROOT) {
    $InstallRoot = $EXPECTED_ROOT
    Log "INFO" ("-SkipExtract: using existing tree at {0}" -f $InstallRoot)
  } else {
    Add-Step "2" "resolve install root" "RED" "no zip and no existing tree at $EXPECTED_ROOT"
    exit 2
  }
}

# ---------------------------------------------------------------------------
# PHASE 3 -- verify + extract (delegate to dist/install.ps1)
# ---------------------------------------------------------------------------

Time-Phase "3-verify-extract" {
  if ($SkipExtract) {
    Add-Step "3" "verify + extract" "SKIPPED" "-SkipExtract set"
    return
  }
  if ($DryRun) {
    Add-Step "3" "verify + extract" "SKIPPED" "(dry-run)"
    return
  }

  # dist/install.ps1 contract: -ZipPath, -HashPath, -Destination, -Force,
  # -SkipDryRun (we always skip its internal dry-run -- our phase 4 IS the
  # live wire-up). It returns 0 on success, 1 on hash mismatch / extract
  # failure, 3 on a yellow dry-run gap (only triggers if -SkipDryRun is not
  # passed; we always pass it).
  $args = @(
    "-NoProfile","-ExecutionPolicy","Bypass",
    "-File", $DIST_INSTALL,
    "-ZipPath", $ZipPath,
    "-HashPath", $HashPath,
    "-Destination", $Destination,
    "-SkipDryRun"
  )
  if ($Force) { $args += "-Force" }

  $outLog = Join-Path $env:TEMP ("orange5-dist-install-{0}.log" -f ([guid]::NewGuid().ToString("N").Substring(0,8)))
  $errLog = "$outLog.err"
  Log "STEP" ("delegating extract to {0}" -f $DIST_INSTALL)
  try {
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc.ExitCode -eq 0) {
      Add-Step "3" "verify + extract" "GREEN" ("install_root={0}" -f $InstallRoot)
    } else {
      $tail = ""
      try { $tail = (Get-Content $outLog -Tail 8 -ErrorAction Stop) -join " | " } catch {}
      if (-not $tail) { try { $tail = (Get-Content $errLog -Tail 8 -ErrorAction Stop) -join " | " } catch {} }
      Add-Step "3" "verify + extract" "RED" ("dist/install.ps1 exit {0} :: {1}" -f $proc.ExitCode, $tail)
      Log "RED" ("see log: {0}" -f $outLog)
      exit 1
    }
  } catch {
    Add-Step "3" "verify + extract" "RED" $_.Exception.Message
    exit 1
  }
}

# After phase 3, the wave12 script lives inside the extracted tree.
$Wave12Path = Join-Path $InstallRoot "scripts\wave12-wire-up.ps1"

# Honor wave12's hard-coded $ORANGE5_ROOT contract. If the extracted tree
# is not at C:\AtomEons\Orange5, wave12 will look at the WRONG path.
# We do not silently rewrite wave12; we surface the gap and either bail
# or (if the canonical root matches the extract) proceed.
if ($InstallRoot -and ($InstallRoot -ine $EXPECTED_ROOT) -and (-not $SkipWave12)) {
  Add-Step "3" "install root matches wave12 expectation" "YELLOW" `
    ("wave12 expects {0}; extract is at {1}" -f $EXPECTED_ROOT, $InstallRoot)
  Log "YELLOW" "wave12-wire-up.ps1 will operate on $EXPECTED_ROOT, not the fresh extract."
  Log "YELLOW" "For a true clean-machine repro, extract under C:\AtomEons (so install_root == $EXPECTED_ROOT)."
}

# ---------------------------------------------------------------------------
# PHASE 4 -- wave12 wire-up (npm install, splice, boot gateway, smokes)
# ---------------------------------------------------------------------------

Time-Phase "4-wave12-wireup" {
  if ($SkipWave12) {
    Add-Step "4" "wave12 wire-up" "SKIPPED" "-SkipWave12 set"
    return
  }
  if ($DryRun) {
    # We DO want to surface what wave12 would say on this box; run it in its
    # own dry-run mode and capture exit code.
    $args = @(
      "-NoProfile","-ExecutionPolicy","Bypass",
      "-File", $Wave12Path, "-DryRun"
    )
    if (-not (Test-Path $Wave12Path)) {
      Add-Step "4" "wave12 wire-up dry-run" "RED" "wave12 not found at $Wave12Path"
      return
    }
    $out = Join-Path $env:TEMP ("orange5-wave12-dry-{0}.log" -f ([guid]::NewGuid().ToString("N").Substring(0,8)))
    $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $out -RedirectStandardError "$out.err"
    if ($proc.ExitCode -eq 0) {
      Add-Step "4" "wave12 wire-up dry-run" "GREEN" $out
    } else {
      Add-Step "4" "wave12 wire-up dry-run" "YELLOW" ("exit {0} :: {1}" -f $proc.ExitCode, $out)
    }
    return
  }

  if (-not (Test-Path $Wave12Path)) {
    Add-Step "4" "wave12 wire-up" "RED" "wave12 not found at $Wave12Path"
    exit 1
  }

  # -Force is required for wave12 to actually restart a running gateway.
  # If the operator did not pass -Force to us, we still pass -Force to
  # wave12 because that is the whole point of the install lane: bring
  # the gateway up green from this exact splice.
  $args = @(
    "-NoProfile","-ExecutionPolicy","Bypass",
    "-File", $Wave12Path, "-Force"
  )
  $out = Join-Path $env:TEMP ("orange5-wave12-{0}.log" -f ([guid]::NewGuid().ToString("N").Substring(0,8)))
  $errOut = "$out.err"
  Log "STEP" ("running wave12-wire-up.ps1 -Force (log: {0})" -f $out)
  $proc = Start-Process -FilePath "powershell.exe" -ArgumentList $args `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $errOut
  if ($proc.ExitCode -eq 0) {
    Add-Step "4" "wave12 wire-up" "GREEN" $out
  } elseif ($proc.ExitCode -eq 1) {
    # wave12 returns 1 when ANY phase had a red row (e.g. one smoke test
    # red while gateway came up fine). We do NOT treat that as fatal here
    # -- the daemon probe in phase 6 is the real source of truth for
    # "is the gateway alive?".
    $tail = ""
    try { $tail = (Get-Content $out -Tail 6 -ErrorAction Stop) -join " | " } catch {}
    Add-Step "4" "wave12 wire-up" "YELLOW" ("exit 1 (red rows in wave12 receipt); see {0} :: {1}" -f $out, $tail)
  } else {
    Add-Step "4" "wave12 wire-up" "RED" ("exit {0}; see {1}" -f $proc.ExitCode, $out)
  }
}

# ---------------------------------------------------------------------------
# PHASE 5 -- boot the remaining daemons (Hermes, 9-Gate, Guardrails)
# ---------------------------------------------------------------------------

function Test-PortAlive {
  param([int]$Port)
  try {
    $tcp = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return @($tcp).Count -gt 0
  } catch { return $false }
}

function Probe-Healthz {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $Url -ErrorAction Stop
    return @{ Ok = ($r.StatusCode -eq 200); Status = $r.StatusCode; Body = $r.Content }
  } catch {
    return @{ Ok = $false; Status = 0; Body = $_.Exception.Message }
  }
}

function Start-DaemonProcess {
  param(
    [string]$Name,
    [string]$Exe,
    [string[]]$Args,
    [string]$Cwd
  )
  if (-not (Test-Path $Cwd)) {
    return @{ Ok = $false; Pid = $null; Log = $null; Error = "cwd missing: $Cwd" }
  }
  $exeResolved = Get-Command $Exe -ErrorAction SilentlyContinue
  if (-not $exeResolved) {
    return @{ Ok = $false; Pid = $null; Log = $null; Error = "exe not on PATH: $Exe (run bootstrap.ps1)" }
  }
  $logDir = Join-Path $env:USERPROFILE "OrangeBox-Data\logs"
  if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $logFile = Join-Path $logDir ("orange5-{0}-{1}.log" -f $Name, $stamp)
  try {
    $proc = Start-Process -FilePath $exeResolved.Source -ArgumentList $Args `
      -WorkingDirectory $Cwd -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
    return @{ Ok = $true; Pid = $proc.Id; Log = $logFile; Error = $null }
  } catch {
    return @{ Ok = $false; Pid = $null; Log = $logFile; Error = $_.Exception.Message }
  }
}

Time-Phase "5-boot-daemons" {
  if ($SkipDaemonBoot) {
    Add-Step "5" "boot daemons" "SKIPPED" "-SkipDaemonBoot set"
    return
  }
  if ($DryRun) {
    Add-Step "5" "boot daemons" "SKIPPED" "(dry-run)"
    return
  }

  foreach ($d in $DAEMONS) {
    if (-not $d.LaunchCmd) {
      # Gateway -- wave12 already booted it. Don't double-launch.
      Add-Step "5" ("boot {0}" -f $d.Name) "SKIPPED" ("brought up by {0}" -f $d.BootedBy)
      continue
    }
    # Idempotency: if the port is already listening, assume the daemon is up
    # and skip the launch. Phase 6 will probe /healthz for truth.
    if (Test-PortAlive -Port $d.Port) {
      Add-Step "5" ("boot {0}" -f $d.Name) "SKIPPED" ("port {0} already listening" -f $d.Port)
      continue
    }
    $cwdAbs = Join-Path $InstallRoot $d.Cwd
    Log "STEP" ("starting {0} ({1} {2}) in {3}" -f $d.Name, $d.LaunchCmd.Exe, ($d.LaunchCmd.Args -join " "), $cwdAbs)
    $res = Start-DaemonProcess -Name $d.Name -Exe $d.LaunchCmd.Exe -Args $d.LaunchCmd.Args -Cwd $cwdAbs
    if ($res.Ok) {
      Add-Step "5" ("boot {0}" -f $d.Name) "GREEN" ("pid={0} log={1}" -f $res.Pid, $res.Log)
    } else {
      Add-Step "5" ("boot {0}" -f $d.Name) "RED" $res.Error
    }
  }
}

# ---------------------------------------------------------------------------
# PHASE 6 -- probe /healthz on all four daemons (truth, not theater)
# ---------------------------------------------------------------------------

function Wait-DaemonHealthz {
  param(
    [string]$Url,
    [int]$BudgetSec = 25,
    [int]$ProbeTimeoutSec = 4,
    [int]$PollMs = 1000
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $deadline = (Get-Date).AddSeconds($BudgetSec)
  $attempts = 0
  $lastErr  = $null
  while ((Get-Date) -lt $deadline) {
    $attempts++
    $r = Probe-Healthz -Url $Url -TimeoutSec $ProbeTimeoutSec
    if ($r.Ok) {
      $sw.Stop()
      return @{
        Ok            = $true
        Status        = $r.Status
        Body          = $r.Body
        ElapsedSec    = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
        Attempts      = $attempts
        FirstByteSec  = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
      }
    }
    $lastErr = $r.Body
    Start-Sleep -Milliseconds $PollMs
  }
  $sw.Stop()
  return @{
    Ok           = $false
    Status       = 0
    Body         = $lastErr
    ElapsedSec   = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
    Attempts     = $attempts
    FirstByteSec = $null
  }
}

Time-Phase "6-probe-healthz" {
  if ($DryRun) {
    Add-Step "6" "probe /healthz" "SKIPPED" "(dry-run)"
    return
  }
  foreach ($d in $DAEMONS) {
    Log "STEP" ("probing {0} at {1} (budget 25s)" -f $d.Name, $d.Healthz)
    $r = Wait-DaemonHealthz -Url $d.Healthz -BudgetSec 25
    $entry = [pscustomobject]@{
      Name         = $d.Name
      Port         = $d.Port
      Healthz      = $d.Healthz
      Ok           = $r.Ok
      Status       = $r.Status
      ElapsedSec   = $r.ElapsedSec
      Attempts     = $r.Attempts
      BodyPreview  = if ($r.Body) {
        $b = $r.Body.ToString()
        if ($b.Length -gt 240) { $b.Substring(0, 240) + "..." } else { $b }
      } else { "" }
    }
    [void]$DAEMON_RESULTS.Add($entry)
    if ($r.Ok) {
      Add-Step "6" ("probe {0}" -f $d.Name) "GREEN" `
        ("HTTP 200 in {0}s, attempts={1}" -f $r.ElapsedSec, $r.Attempts)
    } else {
      Add-Step "6" ("probe {0}" -f $d.Name) "RED" `
        ("no 200 after {0}s, attempts={1}, last_err={2}" -f $r.ElapsedSec, $r.Attempts, ($r.Body | Out-String).Trim())
    }
  }
}

# ---------------------------------------------------------------------------
# PHASE 7 -- receipt + final tally + budget check
# ---------------------------------------------------------------------------

$RunEnd = Get-Date
$TotalSec = [Math]::Round(($RunEnd - $RUN_START).TotalSeconds, 2)
$TotalMin = [Math]::Round($TotalSec / 60.0, 2)
$BudgetSec = $BudgetMinutes * 60
$OverBudget = ($TotalSec -gt $BudgetSec)

$green  = @($STEPS | Where-Object { $_.Status -eq "GREEN"   }).Count
$yellow = @($STEPS | Where-Object { $_.Status -eq "YELLOW"  }).Count
$red    = @($STEPS | Where-Object { $_.Status -eq "RED"     }).Count
$skip   = @($STEPS | Where-Object { $_.Status -eq "SKIPPED" }).Count

$allDaemonsGreen = ($DAEMON_RESULTS.Count -gt 0) -and `
                   (@($DAEMON_RESULTS | Where-Object { -not $_.Ok }).Count -eq 0)

if (-not $ReceiptDir) {
  # Prefer the receipts dir inside the freshly installed tree; fall back to
  # the repo root receipts dir if InstallRoot is null (dry-run, etc.).
  $candidate = $null
  if ($InstallRoot -and (Test-Path $InstallRoot)) {
    $candidate = Join-Path $InstallRoot "10-RECEIPTS\orange5-bootstrap"
  } else {
    $candidate = Join-Path $REPO_ROOT "10-RECEIPTS\orange5-bootstrap"
  }
  $ReceiptDir = $candidate
}
if (-not (Test-Path $ReceiptDir)) {
  try { New-Item -ItemType Directory -Path $ReceiptDir -Force | Out-Null } catch {}
}
$RunStamp = $RUN_START.ToString("yyyy-MM-dd_HH-mm-ss")
$ReceiptPath = Join-Path $ReceiptDir ("{0}-install.md" -f $RunStamp)

$rc = New-Object System.Collections.Generic.List[string]
$rc.Add("# Orange5 sovereign-reproducibility install receipt") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- run id        : $RunStamp") | Out-Null
$rc.Add("- operator      : Atom McCree") | Out-Null
$rc.Add("- host          : $env:COMPUTERNAME") | Out-Null
$rc.Add("- pwsh          : $($PSVersionTable.PSVersion.ToString())") | Out-Null
$rc.Add("- script        : scripts/repro/install.ps1") | Out-Null
$rc.Add("- zip           : $ZipPath") | Out-Null
$rc.Add("- hash manifest : $HashPath") | Out-Null
$rc.Add("- destination   : $Destination") | Out-Null
$rc.Add("- install root  : $InstallRoot") | Out-Null
$rc.Add("- dry-run       : $DryRun") | Out-Null
$rc.Add("- force         : $Force") | Out-Null
$rc.Add("- started at    : $($RUN_START.ToString('o'))") | Out-Null
$rc.Add("- finished at   : $($RunEnd.ToString('o'))") | Out-Null
$rc.Add("- total seconds : $TotalSec  (= $TotalMin min)") | Out-Null
$rc.Add("- budget min    : $BudgetMinutes") | Out-Null
$rc.Add(("- over budget?  : {0}" -f $OverBudget)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Tally") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| color   | count |") | Out-Null
$rc.Add("|---------|-------|") | Out-Null
$rc.Add("| GREEN   | $green |") | Out-Null
$rc.Add("| YELLOW  | $yellow |") | Out-Null
$rc.Add("| RED     | $red |") | Out-Null
$rc.Add("| SKIPPED | $skip |") | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Phase wall-clock") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| phase | seconds |") | Out-Null
$rc.Add("|-------|---------|") | Out-Null
foreach ($p in $PHASE_ORDER) {
  $sec = if ($PHASE_TIMES.ContainsKey($p)) { $PHASE_TIMES[$p] } else { "" }
  $rc.Add("| $p | $sec |") | Out-Null
}
$rc.Add("| **total** | **$TotalSec** |") | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Daemon /healthz probes (truth)") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| daemon | port | ok | http | elapsed_sec | attempts | url |") | Out-Null
$rc.Add("|--------|------|----|------|-------------|----------|-----|") | Out-Null
foreach ($r in $DAEMON_RESULTS) {
  $okMark = if ($r.Ok) { "GREEN" } else { "RED" }
  $rc.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |" -f `
    $r.Name, $r.Port, $okMark, $r.Status, $r.ElapsedSec, $r.Attempts, $r.Healthz)) | Out-Null
}
$rc.Add("") | Out-Null
foreach ($r in $DAEMON_RESULTS) {
  $rc.Add("### $($r.Name) body preview") | Out-Null
  $rc.Add("") | Out-Null
  $rc.Add('```json') | Out-Null
  $rc.Add($r.BodyPreview) | Out-Null
  $rc.Add('```') | Out-Null
  $rc.Add("") | Out-Null
}

$rc.Add("## Steps") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| phase | status | at | name | detail |") | Out-Null
$rc.Add("|-------|--------|----|------|--------|") | Out-Null
foreach ($s in $STEPS) {
  $detail = $s.Detail -replace '\|','\|' -replace "`r?`n"," "
  $rc.Add("| $($s.Phase) | $($s.Status) | $($s.At) | $($s.Name) | $detail |") | Out-Null
}
$rc.Add("") | Out-Null

$rc.Add("## Log") | Out-Null
$rc.Add("") | Out-Null
$rc.Add('```') | Out-Null
foreach ($l in $LOG_LINES) { $rc.Add($l) | Out-Null }
$rc.Add('```') | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Doctrine") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- Mom's Law: full effort; no theater; no silent fallback.") | Out-Null
$rc.Add("- GREEN means: every daemon /healthz returned HTTP 200, every phase") | Out-Null
$rc.Add("  step is GREEN/SKIPPED (no RED), wall-clock <= budget.") | Out-Null
$rc.Add("- Idempotent: re-running this script against an already-installed") | Out-Null
$rc.Add("  tree without -Force refuses extract; daemons already listening") | Out-Null
$rc.Add("  are not double-launched (port-bind check).") | Out-Null
$rc.Add("- Rollback: dist/install.ps1 -Force moves the previous tree to") | Out-Null
$rc.Add("  <Destination>\\.rollback\\<ts>\\. Uninstall via dist/uninstall.ps1.") | Out-Null

# Write receipt UTF-8 no BOM (match the wave12 convention).
try {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($ReceiptPath, (($rc -join "`r`n")), $enc)
  $rsha = (Get-FileHash -LiteralPath $ReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Log "INFO" ("receipt: {0}" -f $ReceiptPath)
  Log "INFO" ("sha256:  {0}" -f $rsha)
} catch {
  Log "RED" ("could not write receipt: {0}" -f $_.Exception.Message)
}

Banner "FINAL TALLY"
$tallyColor = if ($red -gt 0 -or $OverBudget -or (-not $allDaemonsGreen)) { "Red" } `
              elseif ($yellow -gt 0) { "Yellow" } else { "Green" }
Write-Host ("steps  green={0}  yellow={1}  red={2}  skip={3}" -f $green, $yellow, $red, $skip) -ForegroundColor $tallyColor
Write-Host ("daemons all-green={0}  ({1} of {2})" -f $allDaemonsGreen, `
  (@($DAEMON_RESULTS | Where-Object { $_.Ok }).Count), $DAEMON_RESULTS.Count) -ForegroundColor $tallyColor
Write-Host ("wall-clock {0}s ({1} min) / budget {2} min" -f $TotalSec, $TotalMin, $BudgetMinutes) -ForegroundColor $tallyColor

# Exit-code policy (honest):
#   0 -- everything green: every daemon /healthz=200, no red steps, in budget.
#   1 -- one or more daemons RED, or budget exceeded, or any RED step.
#   3 -- wave12 wire-up returned a yellow / red but daemons are alive.
if ($DryRun) {
  Write-Host "exit 0 (dry-run)" -ForegroundColor DarkGray
  exit 0
}
if ($red -gt 0 -or $OverBudget -or (-not $allDaemonsGreen)) {
  Write-Host "exit 1 -- not green" -ForegroundColor Red
  exit 1
}
if ($yellow -gt 0) {
  Write-Host "exit 3 -- green daemons, yellow elsewhere (see receipt)" -ForegroundColor Yellow
  exit 3
}
Write-Host "exit 0 -- Orange5 sovereign-reproducibility GREEN" -ForegroundColor Green
exit 0
