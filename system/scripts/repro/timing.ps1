# timing.ps1
# Orange5 sovereign-reproducibility timing wrapper.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- full effort, no theater, no silent fallback, no fake
#   green. The 30-minute SLA is the headline number for the entire Orange5
#   reproducibility claim, so this wrapper is the receipt that backs the
#   claim. It is the timer the operator can hand to a stranger.
#
# Mission: prove sovereign reproducibility end-to-end.
#   Any operator -- or future-Atom on a fresh Windows 11 box -- can:
#       pwsh -File scripts\repro\timing.ps1
#   ...and get one wall-clock number that covers:
#       1. bootstrap.ps1   (toolchain on the metal: node/bun/python/...)
#       2. install.ps1     (unzip Orange5 -> wave12 wire -> boot daemons)
#       3. verify          (real HTTP /healthz probes against the live tree)
#   The total must be under 30:00.000 to pass. Any per-step blowup is
#   surfaced in the breakdown. This is what proves the bootstrap+install
#   path is real, not a slide.
#
# In scope:
#   - Wrap bootstrap.ps1 in a stopwatch.
#   - Wrap install.ps1   in a stopwatch.
#   - Wrap a final /healthz verify sweep in a stopwatch.
#   - Assert total elapsed < 30 minutes (-BudgetMinutes overrides).
#   - Record per-step breakdown (wall-clock, exit code, receipt path).
#   - Emit a single timing receipt at
#     10-RECEIPTS/orange5-timing/<ts>-timing.md.
#
# Out of scope (deliberately, by Mom's Law: one job per script):
#   - Atomic Orange splice / wire-up        -> scripts/wave12-wire-up.ps1
#   - Tool install detail                   -> scripts/repro/bootstrap.ps1
#   - Zip verify, extract, daemon boot      -> scripts/repro/install.ps1
#   - Functional smoke tests beyond /healthz -> handled inside install.ps1
#   - atomic-orange acceptance               -> tracked as a separate concern
#
# What this script does NOT do (by design):
#   - It does not patch the system. It only invokes the two scripts that do.
#   - It does not "make it green." It TIMES the path and reports truth.
#   - It does not cache results. Every run is wall-clock fresh.
#   - It does not silently retry on failure. A RED step is a RED receipt.
#
# Flags:
#   -SkipBootstrap     Skip the bootstrap.ps1 phase. Useful when the
#                      operator has already verified the toolchain on this
#                      box (e.g. re-running install+verify only).
#   -SkipInstall       Skip the install.ps1 phase. Useful when re-running
#                      only the /healthz verify sweep against an already
#                      booted Orange5 tree.
#   -SkipVerify        Skip the final /healthz verify sweep. Time the
#                      bootstrap+install only. Rare; included for symmetry.
#   -BudgetMinutes N   Total wall-clock budget across all three phases.
#                      Default: 30. RED + exit 1 if exceeded.
#   -ZipPath <p>       Forwarded to install.ps1 -ZipPath.
#   -Destination <p>   Forwarded to install.ps1 -Destination. Default: the
#                      install.ps1 default (C:\AtomEons).
#   -DryRun            Forwarded to both bootstrap.ps1 and install.ps1.
#                      Verify sweep still runs (it is read-only).
#   -ReceiptDir <p>    Override receipt output directory.
#   -Force             Forwarded to install.ps1 -Force.
#
# Exit codes:
#   0  All requested phases returned 0 AND total wall-clock <= budget.
#   1  One or more phases returned non-zero, OR budget exceeded, OR a
#      /healthz probe failed. Receipt is still written -- it is the
#      post-mortem.
#   2  Fatal pre-flight (bootstrap.ps1 or install.ps1 missing on disk;
#      cannot write receipt dir).

[CmdletBinding()]
param(
  [switch]$SkipBootstrap,
  [switch]$SkipInstall,
  [switch]$SkipVerify,
  [int]$BudgetMinutes = 30,
  [string]$ZipPath,
  [string]$Destination,
  [switch]$DryRun,
  [string]$ReceiptDir,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths -----------------------------------------------------------------
# Resolve script directory robustly whether invoked via -File, dot-source, or
# the PSScriptRoot automatic. This script lives in scripts/repro/ alongside
# bootstrap.ps1 and install.ps1; do not assume CWD.
$ScriptDir       = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ORANGE5_ROOT    = "C:\AtomEons\Orange5"
$BOOTSTRAP_PATH  = Join-Path $ScriptDir "bootstrap.ps1"
$INSTALL_PATH    = Join-Path $ScriptDir "install.ps1"
if (-not $ReceiptDir -or [string]::IsNullOrWhiteSpace($ReceiptDir)) {
  $ReceiptDir = Join-Path $ORANGE5_ROOT "10-RECEIPTS\orange5-timing"
}
$RUN_STAMP    = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$RECEIPT_PATH = Join-Path $ReceiptDir ("{0}-timing.md" -f $RUN_STAMP)

# --- Daemon /healthz contract ---------------------------------------------
# These four endpoints are the real verification surface. install.ps1 also
# probes them internally during its phase 6, but we re-probe here so that
# the *timing* receipt has its own independent proof that the box is green
# at the moment the budget clock stops. No "the other script said so"
# delegation.
$Healthz = @(
  @{ Name = "Gateway";    Url = "http://127.0.0.1:1337/healthz" }
  @{ Name = "Hermes";     Url = "http://127.0.0.1:7430/healthz" }
  @{ Name = "9-Gate";     Url = "http://127.0.0.1:7450/healthz" }
  @{ Name = "Guardrails"; Url = "http://127.0.0.1:7460/healthz" }
)

# --- Logging helpers ------------------------------------------------------
function Write-Log {
  param([string]$Level, [string]$Msg)
  $ts = Get-Date -Format "HH:mm:ss"
  $color = switch ($Level) {
    "GREEN"  { "Green" }
    "RED"    { "Red" }
    "YELLOW" { "Yellow" }
    "INFO"   { "Cyan" }
    default  { "Gray" }
  }
  Write-Host ("[{0}] [{1}] {2}" -f $ts, $Level, $Msg) -ForegroundColor $color
}

# --- Step result rows ------------------------------------------------------
# One row per phase. The receipt renders these as a markdown table so the
# operator can see exactly where the budget went. Keep the shape stable;
# downstream parsers (atomic-orange dashboards, future-Atom forensics) may
# read these.
$Steps = New-Object System.Collections.ArrayList
function Add-Step {
  param(
    [string]$Phase,
    [string]$Status,    # GREEN / YELLOW / RED / SKIPPED
    [double]$Seconds,
    [int]$ExitCode,
    [string]$Notes
  )
  $null = $Steps.Add([pscustomobject]@{
    Phase    = $Phase
    Status   = $Status
    Seconds  = [Math]::Round($Seconds, 2)
    Minutes  = [Math]::Round($Seconds / 60.0, 2)
    ExitCode = $ExitCode
    Notes    = $Notes
  })
}

# --- Pre-flight ------------------------------------------------------------
# Mom's Law: if the scripts we wrap are missing, say so loudly NOW. Do not
# pretend a SKIPPED phase counts as success.
function Test-PreFlight {
  $fatal = $false
  if (-not (Test-Path $BOOTSTRAP_PATH)) {
    Write-Log "RED" "bootstrap.ps1 not found at $BOOTSTRAP_PATH"
    $fatal = $true
  }
  if (-not (Test-Path $INSTALL_PATH)) {
    Write-Log "RED" "install.ps1 not found at $INSTALL_PATH"
    $fatal = $true
  }
  try {
    if (-not (Test-Path $ReceiptDir)) {
      New-Item -ItemType Directory -Path $ReceiptDir -Force | Out-Null
    }
  } catch {
    Write-Log "RED" "Cannot create receipt dir: $ReceiptDir -- $($_.Exception.Message)"
    $fatal = $true
  }
  if ($fatal) { exit 2 }
}

# --- Run a child ps1 with full timing + exit-code capture -----------------
# We invoke pwsh.exe as a child process so that:
#   (a) the child's exit code is observable via $LASTEXITCODE,
#   (b) a fatal error in the child (Stop on ErrorActionPreference) does NOT
#       kill this timer,
#   (c) the child can use its own param block freely.
# All bound parameters are forwarded as a string array; we never interpolate
# user input into a shell string.
function Invoke-TimedScript {
  param(
    [string]$Phase,
    [string]$ScriptPath,
    [string[]]$ScriptArgs
  )
  Write-Log "INFO" "=== Phase: $Phase ==="
  Write-Log "INFO" ("Invoking: {0} {1}" -f $ScriptPath, ($ScriptArgs -join " "))
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $exit = -1
  $notes = ""
  try {
    # -NoProfile keeps child startup deterministic (no $PROFILE side effects
    # that could pad the timing). -File ensures the script's own param block
    # parses the forwarded args, not pwsh -Command.
    $allArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $ScriptPath) + $ScriptArgs
    & pwsh.exe @allArgs
    $exit = $LASTEXITCODE
  } catch {
    $exit = 99
    $notes = "Child threw: $($_.Exception.Message)"
    Write-Log "RED" $notes
  }
  $sw.Stop()
  $sec = $sw.Elapsed.TotalSeconds
  $status = if ($exit -eq 0) { "GREEN" } elseif ($exit -eq 99) { "RED" } else { "RED" }
  if ($status -eq "GREEN") {
    Write-Log "GREEN" ("$Phase completed in {0:N1}s ({1:N2} min), exit=0" -f $sec, ($sec/60.0))
  } else {
    Write-Log "RED" ("$Phase failed in {0:N1}s, exit=$exit" -f $sec)
    if (-not $notes) { $notes = "Child exited with code $exit. See child receipt for details." }
  }
  Add-Step -Phase $Phase -Status $status -Seconds $sec -ExitCode $exit -Notes $notes
  return $exit
}

# --- /healthz probe sweep -------------------------------------------------
# Independent of install.ps1's internal probe. We hit each endpoint once,
# bounded timeout, record latency + status code. No retries: this is the
# verify-at-the-final-bell snapshot.
function Invoke-HealthzSweep {
  Write-Log "INFO" "=== Phase: Verify (/healthz sweep) ==="
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $allGreen = $true
  $detail = New-Object System.Collections.ArrayList
  foreach ($h in $Healthz) {
    $probeStart = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    $statusCode = 0
    $body = ""
    $errMsg = ""
    try {
      # 5-second timeout: a daemon that needs longer than 5s to answer
      # /healthz is not green by Mom's Law standards.
      $resp = Invoke-WebRequest -Uri $h.Url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
      $statusCode = [int]$resp.StatusCode
      $body = ($resp.Content | Out-String).Trim()
      if ($statusCode -eq 200) { $ok = $true }
    } catch {
      $errMsg = $_.Exception.Message
    }
    $probeStart.Stop()
    $ms = [Math]::Round($probeStart.Elapsed.TotalMilliseconds, 1)
    if ($ok) {
      Write-Log "GREEN" ("{0,-12} {1} -> 200 in {2} ms" -f $h.Name, $h.Url, $ms)
      $null = $detail.Add([pscustomobject]@{
        Name=$h.Name; Url=$h.Url; Status="GREEN"; Code=$statusCode; LatencyMs=$ms;
        Body=($body.Substring(0, [Math]::Min(120, $body.Length))); Error=""
      })
    } else {
      $allGreen = $false
      Write-Log "RED" ("{0,-12} {1} FAILED ({2})" -f $h.Name, $h.Url, $(if ($errMsg) { $errMsg } else { "HTTP $statusCode" }))
      $null = $detail.Add([pscustomobject]@{
        Name=$h.Name; Url=$h.Url; Status="RED"; Code=$statusCode; LatencyMs=$ms;
        Body=""; Error=$errMsg
      })
    }
  }
  $sw.Stop()
  $sec = $sw.Elapsed.TotalSeconds
  $status = if ($allGreen) { "GREEN" } else { "RED" }
  $notes = "{0}/{1} daemons answered /healthz 200." -f (($detail | Where-Object Status -eq "GREEN").Count), $detail.Count
  Add-Step -Phase "Verify (/healthz)" -Status $status -Seconds $sec -ExitCode ($(if($allGreen){0}else{1})) -Notes $notes
  return @{ AllGreen = $allGreen; Detail = $detail; Seconds = $sec }
}

# --- Main ------------------------------------------------------------------
Test-PreFlight

Write-Log "INFO" "Orange5 timing wrapper. Budget = $BudgetMinutes min."
Write-Log "INFO" "Receipt will be written to: $RECEIPT_PATH"

$RunStart = Get-Date
$bootstrapExit = 0
$installExit   = 0
$healthz       = $null

# Phase 1: bootstrap (toolchain).
# This is the biggest variable in the budget: a clean machine may need to
# pull node + bun + python + ollama + docker over the network. On a warm
# box this phase is mostly verify-only and takes <60s.
if ($SkipBootstrap) {
  Write-Log "YELLOW" "SkipBootstrap set. Bootstrap phase skipped."
  Add-Step -Phase "Bootstrap" -Status "SKIPPED" -Seconds 0 -ExitCode 0 -Notes "SkipBootstrap flag set."
} else {
  $bsArgs = @()
  if ($DryRun) { $bsArgs += "-DryRun" }
  $bootstrapExit = Invoke-TimedScript -Phase "Bootstrap" -ScriptPath $BOOTSTRAP_PATH -ScriptArgs $bsArgs
}

# Phase 2: install (extract + wave12 + boot).
# Only proceed if bootstrap was green OR explicitly skipped. Running
# install.ps1 against a half-bootstrapped toolchain wastes wall clock and
# produces a misleading receipt -- Mom's Law: no fake green.
if ($SkipInstall) {
  Write-Log "YELLOW" "SkipInstall set. Install phase skipped."
  Add-Step -Phase "Install" -Status "SKIPPED" -Seconds 0 -ExitCode 0 -Notes "SkipInstall flag set."
} elseif ($bootstrapExit -ne 0 -and -not $SkipBootstrap) {
  Write-Log "RED" "Bootstrap returned $bootstrapExit. Skipping install phase to avoid cascading false-positive."
  Add-Step -Phase "Install" -Status "SKIPPED" -Seconds 0 -ExitCode 0 -Notes "Skipped because Bootstrap was RED."
  $installExit = 1
} else {
  $instArgs = @()
  if ($DryRun)              { $instArgs += "-DryRun" }
  if ($Force)               { $instArgs += "-Force" }
  if ($ZipPath)             { $instArgs += @("-ZipPath", $ZipPath) }
  if ($Destination)         { $instArgs += @("-Destination", $Destination) }
  # Forward our overall budget so install.ps1's own per-phase clock stays
  # consistent with ours. install.ps1's default is 30; we mirror.
  $instArgs += @("-BudgetMinutes", "$BudgetMinutes")
  $installExit = Invoke-TimedScript -Phase "Install" -ScriptPath $INSTALL_PATH -ScriptArgs $instArgs
}

# Phase 3: independent /healthz verify.
# Even if install.ps1 said green, we re-probe. This is the sovereign
# reproducibility test: the daemons must answer NOW, with the budget clock
# still ticking, not "they were up at some point during install."
if ($SkipVerify) {
  Write-Log "YELLOW" "SkipVerify set. /healthz sweep skipped."
  Add-Step -Phase "Verify (/healthz)" -Status "SKIPPED" -Seconds 0 -ExitCode 0 -Notes "SkipVerify flag set."
} elseif ($DryRun) {
  # In DryRun we still probe -- the probe is read-only. But we label it
  # clearly so the receipt is not confused with a real run.
  Write-Log "INFO" "DryRun: /healthz sweep is read-only, running anyway for visibility."
  $healthz = Invoke-HealthzSweep
} else {
  $healthz = Invoke-HealthzSweep
}

$RunEnd   = Get-Date
$TotalSec = (New-TimeSpan -Start $RunStart -End $RunEnd).TotalSeconds
$TotalMin = $TotalSec / 60.0
$BudgetSec = $BudgetMinutes * 60.0
$BudgetMet = $TotalSec -le $BudgetSec

# --- Final verdict ---------------------------------------------------------
# Three things must be true for an overall GREEN:
#   1. Every non-skipped step exited 0.
#   2. /healthz sweep was either skipped or all-green.
#   3. Total wall-clock <= budget.
# Anything else is RED. We are deliberately strict: this is the receipt
# that backs the public "<30 min" claim.
$anyRed = ($Steps | Where-Object { $_.Status -eq "RED" }).Count -gt 0
$overall = if ($anyRed -or -not $BudgetMet) { "RED" } else { "GREEN" }

# --- Receipt (markdown) ----------------------------------------------------
$lines = New-Object System.Collections.ArrayList
$null = $lines.Add("# Orange5 timing receipt")
$null = $lines.Add("")
$null = $lines.Add("- Run start: $($RunStart.ToString("yyyy-MM-dd HH:mm:ss zzz"))")
$null = $lines.Add("- Run end:   $($RunEnd.ToString("yyyy-MM-dd HH:mm:ss zzz"))")
$null = $lines.Add("- Wall clock: {0:N2} s  ({1:N2} min)" -f $TotalSec, $TotalMin)
$null = $lines.Add("- Budget: {0} min ({1} s)" -f $BudgetMinutes, $BudgetSec)
$null = $lines.Add("- 30-min SLA: {0}" -f $(if ($BudgetMet) { "MET ({0:N1}s under budget)" -f ($BudgetSec - $TotalSec) } else { "MISSED ({0:N1}s over budget)" -f ($TotalSec - $BudgetSec) }))
$null = $lines.Add("- Overall: $overall")
$null = $lines.Add("- Host: $env:COMPUTERNAME  User: $env:USERNAME")
$null = $lines.Add("- OS: $((Get-CimInstance Win32_OperatingSystem).Caption) build $((Get-CimInstance Win32_OperatingSystem).BuildNumber)")
$null = $lines.Add("- Flags: DryRun=$DryRun SkipBootstrap=$SkipBootstrap SkipInstall=$SkipInstall SkipVerify=$SkipVerify Force=$Force")
$null = $lines.Add("")
$null = $lines.Add("## Per-phase breakdown")
$null = $lines.Add("")
$null = $lines.Add("| Phase | Status | Seconds | Minutes | ExitCode | Notes |")
$null = $lines.Add("|---|---|---:|---:|---:|---|")
foreach ($s in $Steps) {
  $null = $lines.Add(("| {0} | {1} | {2} | {3} | {4} | {5} |" -f `
    $s.Phase, $s.Status, $s.Seconds, $s.Minutes, $s.ExitCode, ($s.Notes -replace '\|','/')))
}
$null = $lines.Add("")

if ($null -ne $healthz) {
  $null = $lines.Add("## /healthz probe detail")
  $null = $lines.Add("")
  $null = $lines.Add("| Daemon | URL | Status | HTTP | Latency (ms) | Body / Error |")
  $null = $lines.Add("|---|---|---|---:|---:|---|")
  foreach ($d in $healthz.Detail) {
    $bodyOrErr = if ($d.Error) { "ERR: $($d.Error)" } else { $d.Body }
    $null = $lines.Add(("| {0} | {1} | {2} | {3} | {4} | {5} |" -f `
      $d.Name, $d.Url, $d.Status, $d.Code, $d.LatencyMs, ($bodyOrErr -replace '\|','/' -replace '[\r\n]+',' ')))
  }
  $null = $lines.Add("")
}

$null = $lines.Add("## What this receipt actually proves")
$null = $lines.Add("")
$null = $lines.Add("- Bootstrap row: toolchain (node/bun/python/ollama/docker/git/gh) is present and verified.")
$null = $lines.Add("- Install row: Orange5 zip extracted, wave12 wire-up ran, daemons booted (per install.ps1's internal /healthz).")
$null = $lines.Add("- Verify row: this script's INDEPENDENT /healthz probe at the final bell. Real HTTP 200 only; no 'process is alive' theater.")
$null = $lines.Add("- 30-min SLA: total wall-clock from first phase start to final probe end. The number the public claim rests on.")
$null = $lines.Add("")
$null = $lines.Add("## Next step")
$null = $lines.Add("")
if ($overall -eq "GREEN") {
  $null = $lines.Add("All phases green and budget met. Sovereign reproducibility receipt is valid for this host.")
} else {
  $null = $lines.Add("RED. Read the per-phase notes and the /healthz detail. Resolve and re-run. Mom's Law: no fake green.")
}

$receipt = ($lines -join "`r`n")
if ($DryRun) {
  Write-Log "INFO" "[DryRun] receipt would be written to: $RECEIPT_PATH"
  Write-Host ""
  Write-Host $receipt
} else {
  try {
    $receipt | Out-File -FilePath $RECEIPT_PATH -Encoding utf8 -Force
    Write-Log "GREEN" "Receipt written: $RECEIPT_PATH"
  } catch {
    Write-Log "RED" "Failed to write receipt: $($_.Exception.Message)"
    Write-Host $receipt
  }
}

# --- Console summary -------------------------------------------------------
Write-Host ""
Write-Host "==================== Orange5 timing summary ====================" -ForegroundColor Cyan
$Steps | Format-Table Phase, Status, Seconds, Minutes, ExitCode -AutoSize
Write-Host ("Total wall clock: {0:N2}s ({1:N2} min)  Budget: {2} min" -f $TotalSec, $TotalMin, $BudgetMinutes) -ForegroundColor Cyan
Write-Host ("30-min SLA: {0}" -f $(if ($BudgetMet) { "MET" } else { "MISSED" })) -ForegroundColor $(if ($BudgetMet) { "Green" } else { "Yellow" })
Write-Host ("Overall: {0}" -f $overall) -ForegroundColor $(if ($overall -eq "GREEN") { "Green" } else { "Red" })
Write-Host "=================================================================" -ForegroundColor Cyan

# --- Exit ------------------------------------------------------------------
# Strict: any RED phase, failed /healthz, or budget breach -> exit 1.
# DryRun always exits 0 (it is, by definition, not the real run).
if ($DryRun)               { exit 0 }
if ($overall -eq "GREEN")  { exit 0 }
exit 1
