# verify.ps1
# Orange5 sovereign-reproducibility verifier.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- full effort, no theater, no silent fallback, no fake
#   green. Every smoke test gets a real run. Every battery gets a real exit
#   code. Receipts CLI chain-verify gets the truth. The final tally is honest
#   to the byte: if any subsystem is RED, the script refuses to declare green
#   and exits non-zero, even if the wall-clock receipt looks pretty.
#
# Mission: Sovereign reproducibility, post-install. The pair is
#     bootstrap.ps1   -> toolchain on the metal
#     install.ps1     -> unzip, wire, boot daemons
#     verify.ps1      -> RUN EVERY TEST + battery + chain-verify, prove green
#
#   Any operator -- or future-Atom on a fresh Windows 11 box -- can pull this
#   repo, run all three in order, and reach a state where every subsystem
#   declares itself green via its OWN tests, not a third-party assertion.
#   End-to-end install + boot + verify is the sovereign reproducibility loop.
#
# What this verifies (and ONLY this):
#   - Every smoke-test.mjs under C:\AtomEons\Orange5 -- one node call each,
#     real stdout/stderr captured, real exit code believed.
#   - The 27-guardrails sweep against the live gateway on :1337 via
#     04-CONTROL-PLANE/session-start/guardrails-sweep.mjs.
#   - The wave3-24 red-team battery (8 packs, 100 scenarios) against the
#     live stack via 04-CONTROL-PLANE/red-team/run.mjs.
#   - Receipts CLI chain-verify via bin/receipts.mjs chain-verify.
#
# What this does NOT do (Mom's Law: one job per script):
#   - Install anything                  -> bootstrap.ps1
#   - Boot any daemons                  -> install.ps1
#   - Atomic-orange splice / wire-up    -> scripts/wave12-wire-up.ps1
#   - Touch the SkilSki live app        -> never, anywhere, ever
#
# Idempotency: this script is read-only against the source tree. It writes
#   exactly one artifact: a markdown receipt at
#   10-RECEIPTS/orange5-verify/<ts>-verify.md. Re-running just produces a
#   new dated receipt. No mutation of code, db, or daemon state.
#
# Flags:
#   -SkipSmoke          Skip the smoke-test.mjs sweep.
#   -SkipGuardrails     Skip the guardrails sweep.
#   -SkipRedTeam        Skip the wave3-24 red-team battery.
#   -SkipChainVerify    Skip the receipts CLI chain-verify.
#   -SmokeTimeoutSec N  Per-smoke-test timeout in seconds. Default: 120.
#   -BudgetMinutes  N   Total wall-clock budget. Default: 30. RED if exceeded.
#   -ReceiptDir <p>     Override receipt directory.
#   -DryRun             Discover + count, do not execute. Exits 0 with the
#                       planned-work receipt.
#   -Json               Print a final one-line JSON tally to stdout (for CI).
#
# Exit codes (honest):
#   0  All exercised subsystems GREEN. Wall-clock <= budget. No RED rows.
#   1  At least one RED row, OR budget exceeded. Receipt is still written.
#   2  Fatal pre-flight (node missing, smoke-test discovery broken, cannot
#      write receipt dir).

[CmdletBinding()]
param(
  [switch]$SkipSmoke,
  [switch]$SkipGuardrails,
  [switch]$SkipRedTeam,
  [switch]$SkipChainVerify,
  [int]$SmokeTimeoutSec = 120,
  [int]$BudgetMinutes   = 30,
  [string]$ReceiptDir,
  [switch]$DryRun,
  [switch]$Json
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

$SCRIPT_DIR   = Split-Path -Parent $MyInvocation.MyCommand.Path
$REPO_ROOT    = Split-Path -Parent (Split-Path -Parent $SCRIPT_DIR)   # C:\AtomEons\Orange5
$ORANGE5_ROOT = $REPO_ROOT

$GUARDRAILS_SWEEP = Join-Path $ORANGE5_ROOT "04-CONTROL-PLANE\session-start\guardrails-sweep.mjs"
$REDTEAM_RUNNER   = Join-Path $ORANGE5_ROOT "04-CONTROL-PLANE\red-team\run.mjs"
$RECEIPTS_CLI     = Join-Path $ORANGE5_ROOT "bin\receipts.mjs"

if (-not $ReceiptDir -or $ReceiptDir.Trim() -eq "") {
  $ReceiptDir = Join-Path $ORANGE5_ROOT "10-RECEIPTS\orange5-verify"
}
$RUN_STAMP    = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$RECEIPT_PATH = Join-Path $ReceiptDir ("{0}-verify.md" -f $RUN_STAMP)

# ---------------------------------------------------------------------------
# Receipt scaffolding
# ---------------------------------------------------------------------------

$RUN_START      = Get-Date
$PHASE_TIMES    = @{}                                       # phase -> seconds
$PHASE_ORDER    = New-Object System.Collections.ArrayList
$STEPS          = New-Object System.Collections.ArrayList   # tally rows
$SUBSYSTEMS     = New-Object System.Collections.ArrayList   # subsystem rollup
$LOG_LINES      = New-Object System.Collections.ArrayList
$SMOKE_RESULTS  = New-Object System.Collections.ArrayList
$BATTERY_RESULTS= New-Object System.Collections.ArrayList

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
    "SKIP"   { "DarkGray" }
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
  param(
    [string]$Phase,
    [string]$Name,
    [string]$Status,        # GREEN | RED | YELLOW | SKIP
    [string]$Detail = ""
  )
  [void]$STEPS.Add([pscustomobject]@{
    Phase  = $Phase
    Name   = $Name
    Status = $Status
    Detail = $Detail
    At     = (Get-Date -Format "HH:mm:ss")
  })
  Log $Status ("[{0}] {1} {2}" -f $Phase, $Name, $(if ($Detail) { "-- $Detail" } else { "" }))
}

function Add-Subsystem {
  param(
    [string]$Name,
    [string]$Status,        # GREEN | RED | YELLOW | SKIP
    [int]$Passed = 0,
    [int]$Failed = 0,
    [int]$Skipped = 0,
    [double]$Seconds = 0,
    [string]$Detail = ""
  )
  [void]$SUBSYSTEMS.Add([pscustomobject]@{
    Name    = $Name
    Status  = $Status
    Passed  = $Passed
    Failed  = $Failed
    Skipped = $Skipped
    Seconds = [Math]::Round($Seconds, 2)
    Detail  = $Detail
  })
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
# Helpers -- bounded child-process execution with real exit codes
# ---------------------------------------------------------------------------

function Invoke-Bounded {
  # Runs an external command with a real timeout, captures stdout/stderr and
  # the actual ExitCode. Returns a hashtable:
  #   @{ Ok=bool; ExitCode=int; Stdout=string; Stderr=string;
  #      Seconds=double; TimedOut=bool }
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [int]$TimeoutSec = 120
  )
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName               = $FilePath
  foreach ($a in $ArgumentList) { [void]$psi.ArgumentList.Add($a) }
  $psi.UseShellExecute        = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.CreateNoWindow         = $true
  if ($WorkingDirectory) { $psi.WorkingDirectory = $WorkingDirectory }

  $p = [System.Diagnostics.Process]::new()
  $p.StartInfo = $psi

  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $sbOut = New-Object System.Text.StringBuilder
  $sbErr = New-Object System.Text.StringBuilder
  $outHandler = [System.Diagnostics.DataReceivedEventHandler]{
    param($s,$e) if ($null -ne $e.Data) { [void]$sbOut.AppendLine($e.Data) }
  }
  $errHandler = [System.Diagnostics.DataReceivedEventHandler]{
    param($s,$e) if ($null -ne $e.Data) { [void]$sbErr.AppendLine($e.Data) }
  }
  $p.add_OutputDataReceived($outHandler)
  $p.add_ErrorDataReceived($errHandler)

  [void]$p.Start()
  $p.BeginOutputReadLine()
  $p.BeginErrorReadLine()

  $timedOut = $false
  if (-not $p.WaitForExit($TimeoutSec * 1000)) {
    try { $p.Kill($true) } catch { }
    $timedOut = $true
  }
  # Drain any remaining buffered output after exit/kill.
  $p.WaitForExit()
  $sw.Stop()

  $exit = if ($timedOut) { -1 } else { $p.ExitCode }
  return @{
    Ok       = (-not $timedOut) -and ($exit -eq 0)
    ExitCode = $exit
    Stdout   = $sbOut.ToString()
    Stderr   = $sbErr.ToString()
    Seconds  = [Math]::Round($sw.Elapsed.TotalSeconds, 2)
    TimedOut = $timedOut
  }
}

function Sanitize-Markdown {
  param([string]$Text, [int]$MaxLines = 60)
  if ([string]::IsNullOrEmpty($Text)) { return "" }
  $lines = $Text -split "(`r`n|`n)"
  if ($lines.Count -gt $MaxLines) {
    $head = $lines[0..([Math]::Min($MaxLines-1, $lines.Count-1))]
    $omitted = $lines.Count - $head.Count
    return (($head -join "`n") + "`n... [$omitted more lines omitted]`n")
  }
  return ($lines -join "`n")
}

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

Banner ("Orange5 verify -- budget {0} min" -f $BudgetMinutes)
Log "INFO" ("script dir : {0}" -f $SCRIPT_DIR)
Log "INFO" ("repo root  : {0}" -f $REPO_ROOT)
Log "INFO" ("receipt    : {0}" -f $RECEIPT_PATH)
Log "INFO" ("dry-run    : {0}" -f $DryRun)

try {
  if (-not (Test-Path $ReceiptDir)) {
    [void](New-Item -ItemType Directory -Path $ReceiptDir -Force)
  }
} catch {
  Log "RED" ("cannot create receipt dir: {0}" -f $_.Exception.Message)
  exit 2
}

Time-Phase "0-preflight" {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) {
    Add-Step "0" "node on PATH" "RED" "run bootstrap.ps1 first"
    Log "RED" "node missing -- bootstrap.ps1 is the toolchain installer"
    exit 2
  }
  $nodeVer = (& node --version) 2>$null
  Add-Step "0" "node on PATH" "GREEN" $nodeVer

  if (-not (Test-Path $ORANGE5_ROOT)) {
    Add-Step "0" "Orange5 tree present" "RED" $ORANGE5_ROOT
    exit 2
  }
  Add-Step "0" "Orange5 tree present" "GREEN" $ORANGE5_ROOT

  # Required runners (only mark RED if the corresponding phase isn't skipped).
  if (-not $SkipGuardrails) {
    if (Test-Path $GUARDRAILS_SWEEP) {
      Add-Step "0" "guardrails-sweep present" "GREEN" $GUARDRAILS_SWEEP
    } else {
      Add-Step "0" "guardrails-sweep present" "RED" $GUARDRAILS_SWEEP
    }
  }
  if (-not $SkipRedTeam) {
    if (Test-Path $REDTEAM_RUNNER) {
      Add-Step "0" "red-team runner present" "GREEN" $REDTEAM_RUNNER
    } else {
      Add-Step "0" "red-team runner present" "RED" $REDTEAM_RUNNER
    }
  }
  if (-not $SkipChainVerify) {
    if (Test-Path $RECEIPTS_CLI) {
      Add-Step "0" "receipts CLI present" "GREEN" $RECEIPTS_CLI
    } else {
      Add-Step "0" "receipts CLI present" "RED" $RECEIPTS_CLI
    }
  }
}

# ---------------------------------------------------------------------------
# PHASE 1 -- smoke-test.mjs sweep
# ---------------------------------------------------------------------------

function Find-SmokeTests {
  # Discover every smoke-test.mjs under $ORANGE5_ROOT, EXCLUDING node_modules,
  # archive, held, and dist roots. The discovery itself is part of the proof
  # surface -- the count goes into the receipt.
  $skipPatterns = @(
    "\node_modules\",
    "\19-ARCHIVE\",
    "\18-HELD\",
    "\dist\node_modules\",
    "\.rollback\"
  )
  $hits = Get-ChildItem -Path $ORANGE5_ROOT -Recurse -File `
            -Filter "smoke-test.mjs" -ErrorAction SilentlyContinue
  $kept = New-Object System.Collections.ArrayList
  foreach ($h in $hits) {
    $skip = $false
    foreach ($pat in $skipPatterns) {
      if ($h.FullName -like "*$pat*") { $skip = $true; break }
    }
    if (-not $skip) { [void]$kept.Add($h) }
  }
  return ,($kept | Sort-Object FullName)
}

if ($SkipSmoke) {
  Add-Step "1" "smoke-test sweep" "SKIP" "-SkipSmoke set"
  Add-Subsystem "smoke-tests" "SKIP" 0 0 0 0 "-SkipSmoke"
} else {
  Time-Phase "1-smoke-tests" {
    $found = Find-SmokeTests
    Log "INFO" ("discovered {0} smoke-test.mjs file(s)" -f $found.Count)

    $passed = 0; $failed = 0; $skipped = 0
    $secsTotal = 0.0

    if ($found.Count -eq 0) {
      Add-Step "1" "smoke discovery" "RED" "no smoke-test.mjs found"
    } else {
      Add-Step "1" "smoke discovery" "GREEN" ("count={0}" -f $found.Count)
    }

    foreach ($f in $found) {
      $rel = $f.FullName.Substring($ORANGE5_ROOT.Length).TrimStart('\','/')
      if ($DryRun) {
        Add-Step "1" $rel "SKIP" "dry-run"
        $skipped++
        [void]$SMOKE_RESULTS.Add([pscustomobject]@{
          Path=$rel; Status="SKIP"; ExitCode=$null; Seconds=0; TimedOut=$false; ErrPreview=""
        })
        continue
      }

      $res = Invoke-Bounded -FilePath "node" `
                            -ArgumentList @($f.FullName) `
                            -WorkingDirectory (Split-Path -Parent $f.FullName) `
                            -TimeoutSec $SmokeTimeoutSec
      $secsTotal += $res.Seconds

      $status = if ($res.Ok) { "GREEN" } elseif ($res.TimedOut) { "RED" } else { "RED" }
      if ($res.Ok) { $passed++ } else { $failed++ }

      $detail = if ($res.TimedOut) { "TIMEOUT after $SmokeTimeoutSec s" } `
                else { "exit=$($res.ExitCode) t=$($res.Seconds)s" }
      Add-Step "1" $rel $status $detail

      $errPrev = ""
      if (-not $res.Ok) {
        $combined = $res.Stderr
        if ([string]::IsNullOrWhiteSpace($combined)) { $combined = $res.Stdout }
        $errPrev = Sanitize-Markdown $combined 30
      }
      [void]$SMOKE_RESULTS.Add([pscustomobject]@{
        Path     = $rel
        Status   = $status
        ExitCode = $res.ExitCode
        Seconds  = $res.Seconds
        TimedOut = $res.TimedOut
        ErrPreview = $errPrev
      })
    }

    $sub = if ($failed -gt 0) { "RED" } elseif ($passed -gt 0) { "GREEN" } else { "RED" }
    Add-Subsystem "smoke-tests" $sub $passed $failed $skipped $secsTotal `
      ("found={0} passed={1} failed={2} skipped={3}" -f $found.Count, $passed, $failed, $skipped)
  }
}

# ---------------------------------------------------------------------------
# PHASE 2 -- 27-guardrails sweep
# ---------------------------------------------------------------------------

if ($SkipGuardrails) {
  Add-Step "2" "guardrails sweep" "SKIP" "-SkipGuardrails set"
  Add-Subsystem "guardrails" "SKIP" 0 0 0 0 "-SkipGuardrails"
} else {
  Time-Phase "2-guardrails" {
    if (-not (Test-Path $GUARDRAILS_SWEEP)) {
      Add-Step "2" "guardrails sweep" "RED" "runner missing"
      Add-Subsystem "guardrails" "RED" 0 0 0 0 "runner missing"
      return
    }
    if ($DryRun) {
      Add-Step "2" "guardrails sweep" "SKIP" "dry-run"
      Add-Subsystem "guardrails" "SKIP" 0 0 0 0 "dry-run"
      return
    }

    # The sweep runner hits the gateway at 127.0.0.1:1337. It exits non-zero
    # only on script-level error; the "violations" tally is in stdout JSON.
    # We treat both surfaces as truth: process exit-code AND the parsed body.
    $res = Invoke-Bounded -FilePath "node" `
                          -ArgumentList @($GUARDRAILS_SWEEP) `
                          -WorkingDirectory (Split-Path -Parent $GUARDRAILS_SWEEP) `
                          -TimeoutSec ([Math]::Max(60, $SmokeTimeoutSec))

    $ran=0; $passed=0; $failed=0; $available=$false
    $parseErr = ""
    if (-not [string]::IsNullOrWhiteSpace($res.Stdout)) {
      try {
        # The sweep prints a single JSON line OR a JSON block; grab the last
        # non-empty line that starts with '{' and parse it.
        $jsonLine = $null
        foreach ($ln in ($res.Stdout -split "(`r`n|`n)")) {
          $t = $ln.Trim()
          if ($t.StartsWith("{") -and $t.EndsWith("}")) { $jsonLine = $t }
        }
        if ($jsonLine) {
          $obj = $jsonLine | ConvertFrom-Json
          if ($obj.PSObject.Properties.Name -contains "available") { $available = [bool]$obj.available }
          if ($obj.PSObject.Properties.Name -contains "ran")       { $ran    = [int]$obj.ran }
          if ($obj.PSObject.Properties.Name -contains "passed")    { $passed = [int]$obj.passed }
          if ($obj.PSObject.Properties.Name -contains "failed")    { $failed = [int]$obj.failed }
        }
      } catch {
        $parseErr = $_.Exception.Message
      }
    }

    $green = $res.Ok -and $available -and ($failed -eq 0) -and ($ran -gt 0)
    $status = if ($green) { "GREEN" } else { "RED" }
    $detail = "ran=$ran passed=$passed failed=$failed available=$available exit=$($res.ExitCode) t=$($res.Seconds)s"
    if ($parseErr) { $detail += " parse_err=$parseErr" }
    Add-Step "2" "guardrails sweep" $status $detail
    Add-Subsystem "guardrails" $status $passed $failed 0 $res.Seconds $detail

    if (-not $green) {
      [void]$BATTERY_RESULTS.Add([pscustomobject]@{
        Name="guardrails"
        Stdout=(Sanitize-Markdown $res.Stdout 40)
        Stderr=(Sanitize-Markdown $res.Stderr 40)
      })
    }
  }
}

# ---------------------------------------------------------------------------
# PHASE 3 -- wave3-24 red-team battery
# ---------------------------------------------------------------------------

if ($SkipRedTeam) {
  Add-Step "3" "red-team battery" "SKIP" "-SkipRedTeam set"
  Add-Subsystem "red-team" "SKIP" 0 0 0 0 "-SkipRedTeam"
} else {
  Time-Phase "3-red-team" {
    if (-not (Test-Path $REDTEAM_RUNNER)) {
      Add-Step "3" "red-team battery" "RED" "runner missing"
      Add-Subsystem "red-team" "RED" 0 0 0 0 "runner missing"
      return
    }
    if ($DryRun) {
      Add-Step "3" "red-team battery" "SKIP" "dry-run"
      Add-Subsystem "red-team" "SKIP" 0 0 0 0 "dry-run"
      return
    }

    # The red-team runner exits 0 iff every scenario was REFUSED at the
    # expected gate. Exit 1 = breach. Exit 2 = runner-level error. We trust
    # the exit code; --json gives a parsable surface for the receipt.
    $res = Invoke-Bounded -FilePath "node" `
                          -ArgumentList @($REDTEAM_RUNNER, "--json") `
                          -WorkingDirectory (Split-Path -Parent $REDTEAM_RUNNER) `
                          -TimeoutSec ([Math]::Max(300, $SmokeTimeoutSec * 3))

    $packs=0; $scenarios=0; $passed=0; $breaches=0
    $parseErr = ""
    if (-not [string]::IsNullOrWhiteSpace($res.Stdout)) {
      try {
        $jsonLine = $null
        $buf = New-Object System.Text.StringBuilder
        $inJson = $false
        foreach ($ln in ($res.Stdout -split "(`r`n|`n)")) {
          $t = $ln.TrimEnd()
          if (-not $inJson -and $t.TrimStart().StartsWith("{")) { $inJson = $true }
          if ($inJson) { [void]$buf.AppendLine($t) }
        }
        $jsonBlob = $buf.ToString().Trim()
        if ($jsonBlob) {
          $obj = $jsonBlob | ConvertFrom-Json
          if ($obj.PSObject.Properties.Name -contains "packs")     { $packs     = [int]$obj.packs }
          if ($obj.PSObject.Properties.Name -contains "scenarios") { $scenarios = [int]$obj.scenarios }
          if ($obj.PSObject.Properties.Name -contains "passed")    { $passed    = [int]$obj.passed }
          if ($obj.PSObject.Properties.Name -contains "breaches")  { $breaches  = [int]$obj.breaches }
        }
      } catch {
        $parseErr = $_.Exception.Message
      }
    }

    $green = $res.Ok -and ($breaches -eq 0)
    $status = if ($green) { "GREEN" } else { "RED" }
    $detail = "packs=$packs scenarios=$scenarios passed=$passed breaches=$breaches exit=$($res.ExitCode) t=$($res.Seconds)s"
    if ($parseErr) { $detail += " parse_err=$parseErr" }
    Add-Step "3" "red-team battery" $status $detail
    Add-Subsystem "red-team" $status $passed $breaches 0 $res.Seconds $detail

    if (-not $green) {
      [void]$BATTERY_RESULTS.Add([pscustomobject]@{
        Name="red-team"
        Stdout=(Sanitize-Markdown $res.Stdout 60)
        Stderr=(Sanitize-Markdown $res.Stderr 40)
      })
    }
  }
}

# ---------------------------------------------------------------------------
# PHASE 4 -- receipts CLI chain-verify
# ---------------------------------------------------------------------------

if ($SkipChainVerify) {
  Add-Step "4" "receipts chain-verify" "SKIP" "-SkipChainVerify set"
  Add-Subsystem "receipts-chain" "SKIP" 0 0 0 0 "-SkipChainVerify"
} else {
  Time-Phase "4-chain-verify" {
    if (-not (Test-Path $RECEIPTS_CLI)) {
      Add-Step "4" "receipts chain-verify" "RED" "CLI missing"
      Add-Subsystem "receipts-chain" "RED" 0 0 0 0 "CLI missing"
      return
    }
    if ($DryRun) {
      Add-Step "4" "receipts chain-verify" "SKIP" "dry-run"
      Add-Subsystem "receipts-chain" "SKIP" 0 0 0 0 "dry-run"
      return
    }

    # bin/receipts.mjs chain-verify exits 0 iff the markdown ledger is
    # cryptographically intact (per the CLI's own --self-test contract).
    $res = Invoke-Bounded -FilePath "node" `
                          -ArgumentList @($RECEIPTS_CLI, "chain-verify") `
                          -WorkingDirectory $ORANGE5_ROOT `
                          -TimeoutSec ([Math]::Max(60, $SmokeTimeoutSec))

    $status = if ($res.Ok) { "GREEN" } else { "RED" }
    $detail = "exit=$($res.ExitCode) t=$($res.Seconds)s"
    Add-Step "4" "receipts chain-verify" $status $detail
    Add-Subsystem "receipts-chain" $status (if ($res.Ok) {1} else {0}) (if ($res.Ok) {0} else {1}) 0 $res.Seconds $detail

    if (-not $res.Ok) {
      [void]$BATTERY_RESULTS.Add([pscustomobject]@{
        Name="receipts-chain"
        Stdout=(Sanitize-Markdown $res.Stdout 40)
        Stderr=(Sanitize-Markdown $res.Stderr 40)
      })
    }
  }
}

# ---------------------------------------------------------------------------
# Tally + receipt
# ---------------------------------------------------------------------------

$RUN_END = Get-Date
$TotalSec = [Math]::Round(($RUN_END - $RUN_START).TotalSeconds, 2)
$TotalMin = [Math]::Round($TotalSec / 60.0, 2)
$OverBudget = $TotalMin -gt $BudgetMinutes

$green  = (@($STEPS | Where-Object { $_.Status -eq "GREEN" })).Count
$yellow = (@($STEPS | Where-Object { $_.Status -eq "YELLOW" })).Count
$red    = (@($STEPS | Where-Object { $_.Status -eq "RED" })).Count
$skip   = (@($STEPS | Where-Object { $_.Status -eq "SKIP" })).Count

$anyRedSubsystem = (@($SUBSYSTEMS | Where-Object { $_.Status -eq "RED" })).Count -gt 0

Banner "FINAL TALLY"
$tallyColor = if ($red -gt 0 -or $anyRedSubsystem -or $OverBudget) { "Red" } `
              elseif ($yellow -gt 0) { "Yellow" } else { "Green" }

Write-Host ("steps        green={0}  yellow={1}  red={2}  skip={3}" -f $green, $yellow, $red, $skip) -ForegroundColor $tallyColor
Write-Host ("subsystems   " + (($SUBSYSTEMS | ForEach-Object { "$($_.Name)=$($_.Status)" }) -join "  ")) -ForegroundColor $tallyColor
Write-Host ("wall-clock   {0}s ({1} min) / budget {2} min" -f $TotalSec, $TotalMin, $BudgetMinutes) -ForegroundColor $tallyColor

# Build the markdown receipt.
$rc = New-Object System.Collections.ArrayList
[void]$rc.Add("# Orange5 verify receipt -- $RUN_STAMP")
[void]$rc.Add("")
[void]$rc.Add("- doctrine: Mom's Law -- full effort; no theater; no silent fallback.")
[void]$rc.Add("- script:   scripts/repro/verify.ps1")
[void]$rc.Add("- repo:     $REPO_ROOT")
[void]$rc.Add("- dry-run:  $DryRun")
[void]$rc.Add("- start:    $($RUN_START.ToString('o'))")
[void]$rc.Add("- end:      $($RUN_END.ToString('o'))")
[void]$rc.Add("- total:    $TotalSec s ($TotalMin min) / budget $BudgetMinutes min")
[void]$rc.Add("- over-budget: $OverBudget")
[void]$rc.Add("")

[void]$rc.Add("## Subsystem rollup")
[void]$rc.Add("")
[void]$rc.Add("| subsystem | status | passed | failed | skipped | seconds | detail |")
[void]$rc.Add("|-----------|--------|--------|--------|---------|---------|--------|")
foreach ($s in $SUBSYSTEMS) {
  $detail = $s.Detail -replace '\|','\|' -replace "`r?`n"," "
  [void]$rc.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |" -f `
    $s.Name, $s.Status, $s.Passed, $s.Failed, $s.Skipped, $s.Seconds, $detail))
}
[void]$rc.Add("")

[void]$rc.Add("## Tally")
[void]$rc.Add("")
[void]$rc.Add("| pill | count |")
[void]$rc.Add("|------|-------|")
[void]$rc.Add("| GREEN   | $green |")
[void]$rc.Add("| YELLOW  | $yellow |")
[void]$rc.Add("| RED     | $red |")
[void]$rc.Add("| SKIPPED | $skip |")
[void]$rc.Add("")

[void]$rc.Add("## Phase wall-clock")
[void]$rc.Add("")
[void]$rc.Add("| phase | seconds |")
[void]$rc.Add("|-------|---------|")
foreach ($p in $PHASE_ORDER) {
  $sec = if ($PHASE_TIMES.ContainsKey($p)) { $PHASE_TIMES[$p] } else { "" }
  [void]$rc.Add("| $p | $sec |")
}
[void]$rc.Add("| **total** | **$TotalSec** |")
[void]$rc.Add("")

[void]$rc.Add("## Smoke tests")
[void]$rc.Add("")
if ($SMOKE_RESULTS.Count -eq 0) {
  [void]$rc.Add("(none -- skipped or no files discovered)")
} else {
  [void]$rc.Add("| path | status | exit | seconds | timeout |")
  [void]$rc.Add("|------|--------|------|---------|---------|")
  foreach ($r in $SMOKE_RESULTS) {
    $ec = if ($null -eq $r.ExitCode) { "" } else { "$($r.ExitCode)" }
    [void]$rc.Add(("| {0} | {1} | {2} | {3} | {4} |" -f `
      $r.Path, $r.Status, $ec, $r.Seconds, $r.TimedOut))
  }
  [void]$rc.Add("")
  $reds = @($SMOKE_RESULTS | Where-Object { $_.Status -eq "RED" })
  if ($reds.Count -gt 0) {
    [void]$rc.Add("### Smoke RED stderr previews")
    [void]$rc.Add("")
    foreach ($r in $reds) {
      [void]$rc.Add("#### $($r.Path)")
      [void]$rc.Add("")
      [void]$rc.Add('```')
      [void]$rc.Add($r.ErrPreview)
      [void]$rc.Add('```')
      [void]$rc.Add("")
    }
  }
}

if ($BATTERY_RESULTS.Count -gt 0) {
  [void]$rc.Add("## Battery RED output")
  [void]$rc.Add("")
  foreach ($b in $BATTERY_RESULTS) {
    [void]$rc.Add("### $($b.Name) -- stdout")
    [void]$rc.Add("")
    [void]$rc.Add('```')
    [void]$rc.Add($b.Stdout)
    [void]$rc.Add('```')
    [void]$rc.Add("")
    if (-not [string]::IsNullOrWhiteSpace($b.Stderr)) {
      [void]$rc.Add("### $($b.Name) -- stderr")
      [void]$rc.Add("")
      [void]$rc.Add('```')
      [void]$rc.Add($b.Stderr)
      [void]$rc.Add('```')
      [void]$rc.Add("")
    }
  }
}

[void]$rc.Add("## Steps")
[void]$rc.Add("")
[void]$rc.Add("| phase | status | at | name | detail |")
[void]$rc.Add("|-------|--------|----|------|--------|")
foreach ($s in $STEPS) {
  $detail = $s.Detail -replace '\|','\|' -replace "`r?`n"," "
  [void]$rc.Add("| $($s.Phase) | $($s.Status) | $($s.At) | $($s.Name) | $detail |")
}
[void]$rc.Add("")

[void]$rc.Add("## Log")
[void]$rc.Add("")
[void]$rc.Add('```')
foreach ($l in $LOG_LINES) { [void]$rc.Add($l) }
[void]$rc.Add('```')
[void]$rc.Add("")

[void]$rc.Add("## Doctrine")
[void]$rc.Add("")
[void]$rc.Add("- Sovereign reproducibility: bootstrap.ps1 -> install.ps1 -> verify.ps1")
[void]$rc.Add("  on a fresh Windows 11 box must reach GREEN in < 30 min wall-clock.")
[void]$rc.Add("- GREEN means: every exercised subsystem returned GREEN, no RED step,")
[void]$rc.Add("  wall-clock <= budget. SKIP is not GREEN; SKIP is honest absence.")
[void]$rc.Add("- The smoke sweep, the guardrails sweep, the wave3-24 red-team battery,")
[void]$rc.Add("  and the receipts CLI chain-verify each declare themselves through")
[void]$rc.Add("  their OWN exit code or parsed verdict. verify.ps1 only believes them.")
[void]$rc.Add("- NOT atomic-orange (that lane lives in wave12-wire-up.ps1).")

# Write receipt UTF-8 no BOM.
try {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($RECEIPT_PATH, (($rc -join "`r`n")), $enc)
  $rsha = (Get-FileHash -LiteralPath $RECEIPT_PATH -Algorithm SHA256).Hash.ToLowerInvariant()
  Log "INFO" ("receipt: {0}" -f $RECEIPT_PATH)
  Log "INFO" ("sha256:  {0}" -f $rsha)
} catch {
  Log "RED" ("could not write receipt: {0}" -f $_.Exception.Message)
}

if ($Json) {
  $jsonOut = @{
    ok          = (-not ($red -gt 0 -or $anyRedSubsystem -or $OverBudget))
    total_sec   = $TotalSec
    total_min   = $TotalMin
    budget_min  = $BudgetMinutes
    over_budget = $OverBudget
    steps       = @{ green=$green; yellow=$yellow; red=$red; skip=$skip }
    subsystems  = @($SUBSYSTEMS | ForEach-Object {
                    @{ name=$_.Name; status=$_.Status; passed=$_.Passed;
                       failed=$_.Failed; skipped=$_.Skipped; seconds=$_.Seconds } })
    receipt     = $RECEIPT_PATH
  } | ConvertTo-Json -Depth 5 -Compress
  Write-Host $jsonOut
}

# Exit-code policy (honest):
#   0 -- every subsystem GREEN or SKIP, no RED, in budget.
#   1 -- any RED step OR any RED subsystem OR budget exceeded.
#   2 -- fatal pre-flight (handled earlier with explicit exit 2).
if ($DryRun) {
  Write-Host "exit 0 (dry-run)" -ForegroundColor DarkGray
  exit 0
}
if ($red -gt 0 -or $anyRedSubsystem -or $OverBudget) {
  Write-Host "exit 1 -- not green (refusing to declare green with any RED)" -ForegroundColor Red
  exit 1
}
Write-Host "exit 0 -- Orange5 verify GREEN" -ForegroundColor Green
exit 0
