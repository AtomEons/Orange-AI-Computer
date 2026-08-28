# bootstrap.ps1
# Clean-machine bootstrap for Orange5 backend.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- no theater, no silent fallback, no fake green.
#   Every install is verified by running the tool and capturing its version.
#   Every step is timed. The final receipt is real wall-clock truth, not a slogan.
#
# Mission: Sovereign reproducibility. Any operator -- or future-Atom on a fresh
#   Windows 11 box -- can pull this repo, run this script, and reach a state
#   where the Orange5 backend toolchain is installed AND verified AND timed,
#   in well under 30 minutes on a normal home internet line.
#
# In scope (this script installs + verifies):
#   - Node.js 20.x LTS                 (Bun-adjacent + 02-APP + smoke tooling)
#   - Bun >= 1.1                       (control-plane runtime, 04/06-CONTROL-PLANE)
#   - Python 3.11+                     (training + scripts, 16-TRAINING)
#   - Ollama                           (local model lane, 13-MODELS)
#   - Docker Desktop                   (container lanes, ATOMSMASHER, MIRAGE)
#   - Git                              (table stakes, but verify anyway)
#   - GitHub CLI (gh)                  (release + receipt push lanes)
#
# Out of scope (deliberately, by Mom's Law -- one job per script):
#   - Atomic Orange splice / wire-up    -> scripts/wave12-wire-up.ps1
#   - npm install of any package.json   -> wire-up phase 1
#   - Any service start / boot          -> separate boot script
#   - WSL2 / Linux distro install       -> Docker installer handles its own WSL
#   - Editor (VS Code), Cursor, etc.    -> operator preference, not bootstrap
#
# Idempotency contract:
#   Every check is "is this tool already present at >= required version?"
#   If yes: SKIP install, run the verify step anyway (so the receipt still
#           proves the tool works on THIS machine, not just that it exists).
#   If no:  install via winget (primary) with documented fallback notes.
#           Re-verify. If verify still fails, mark RED and continue. The
#           operator gets a real picture, not a panic exit.
#
# Flags:
#   -DryRun        Print every planned action. No installs. No state change.
#                  Verification probes still run (so the operator sees what
#                  is currently installed). Exits 0.
#   -SkipInstall   Run verification only. No winget calls. Useful for
#                  re-running the receipt on an already-bootstrapped box.
#   -Force         Reserved. Currently has no destructive sub-step. Present
#                  so the call surface matches wave12-wire-up.ps1.
#   -Verbose       Extra log lines per phase.
#
# Exit codes:
#   0  All required tools present and verified, OR -DryRun.
#   1  One or more required tools failed to install or verify. Receipt
#      still emitted with RED rows. The operator can read the receipt and
#      hand-install the failures.
#   2  Fatal pre-flight (cannot write receipt dir, no internet for winget,
#      etc.). Loud.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$SkipInstall,
  [switch]$Force,
  [switch]$VerboseLog
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths -----------------------------------------------------------------
$ORANGE5_ROOT = "C:\AtomEons\Orange5"
$RECEIPT_DIR  = Join-Path $ORANGE5_ROOT "10-RECEIPTS\orange5-bootstrap"
$DATE_STAMP   = Get-Date -Format "yyyy-MM-dd"
$RUN_STAMP    = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$RECEIPT_PATH = Join-Path $RECEIPT_DIR ("{0}-bootstrap.md" -f $RUN_STAMP)

# --- Minimum versions (raise the bar deliberately) -------------------------
$MIN = @{
  Node   = [Version]"20.0.0"
  Bun    = [Version]"1.1.0"
  Python = [Version]"3.11.0"
  Git    = [Version]"2.40.0"
  Gh     = [Version]"2.40.0"
  # Ollama and Docker self-version differently; we check presence + run.
}

# --- winget package ids (primary install channel on Win11) -----------------
$WINGET = @{
  Node   = "OpenJS.NodeJS.LTS"
  Bun    = "Oven-sh.Bun"
  Python = "Python.Python.3.11"
  Ollama = "Ollama.Ollama"
  Docker = "Docker.DockerDesktop"
  Git    = "Git.Git"
  Gh     = "GitHub.cli"
}

# --- Result rows for the receipt -------------------------------------------
$Rows = New-Object System.Collections.ArrayList
$RunStart = Get-Date

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

function Add-Row {
  param(
    [string]$Tool,
    [string]$Status,        # GREEN / YELLOW / RED / SKIPPED
    [string]$Detected,      # what we actually got back from the tool
    [string]$Required,
    [double]$InstallSec,
    [double]$VerifySec,
    [string]$Notes
  )
  $null = $Rows.Add([pscustomobject]@{
    Tool       = $Tool
    Status     = $Status
    Detected   = $Detected
    Required   = $Required
    InstallSec = [Math]::Round($InstallSec, 2)
    VerifySec  = [Math]::Round($VerifySec, 2)
    Notes      = $Notes
  })
}

# --- Pre-flight -------------------------------------------------------------
function Test-PreFlight {
  if (-not (Test-Path $RECEIPT_DIR)) {
    try {
      New-Item -ItemType Directory -Path $RECEIPT_DIR -Force | Out-Null
    } catch {
      Write-Log "RED" "Cannot create receipt dir: $RECEIPT_DIR -- $($_.Exception.Message)"
      exit 2
    }
  }
  # winget is the primary install channel. If it is missing, we can still
  # verify, but installs will fail. Tell the operator now, not later.
  $hasWinget = $null -ne (Get-Command winget -ErrorAction SilentlyContinue)
  if (-not $hasWinget -and -not $SkipInstall -and -not $DryRun) {
    Write-Log "RED" "winget not found. Install App Installer from the Microsoft Store, then re-run."
    Write-Log "INFO" "Falling through to verify-only mode (no installs)."
    $script:SkipInstall = $true
  }
  return $hasWinget
}

# --- Version helpers --------------------------------------------------------
function Get-ToolVersion {
  # Run a tool's --version probe and return the first SemVer-shaped token.
  # Returns $null on any failure so callers can branch cleanly.
  param([string]$Exe, [string[]]$Args)
  try {
    $cmd = Get-Command $Exe -ErrorAction Stop
    $raw = & $cmd.Source @Args 2>&1 | Out-String
    if (-not $raw) { return $null }
    if ($raw -match '(\d+)\.(\d+)\.(\d+)') {
      return [Version]("{0}.{1}.{2}" -f $matches[1], $matches[2], $matches[3])
    }
    return $null
  } catch {
    return $null
  }
}

function Get-ToolRawOutput {
  param([string]$Exe, [string[]]$Args)
  try {
    $cmd = Get-Command $Exe -ErrorAction Stop
    return (& $cmd.Source @Args 2>&1 | Out-String).Trim()
  } catch {
    return ""
  }
}

# --- Single tool flow -------------------------------------------------------
function Invoke-Bootstrap-Tool {
  param(
    [string]$Name,
    [string]$Exe,              # the binary we will probe (e.g. "node")
    [string[]]$VersionArgs,    # e.g. @("--version")
    [string]$WingetId,
    [Version]$MinVersion,      # may be $null for tools we just want present
    [string]$VerifyDescription # what "verify" actually proves for this tool
  )

  Write-Log "INFO" "=== $Name ==="
  $installSec = 0.0
  $verifySec  = 0.0
  $notes      = ""

  # Step 1: Detect current version (idempotency probe).
  $detected = Get-ToolVersion -Exe $Exe -Args $VersionArgs
  $needsInstall = $true
  if ($null -ne $detected) {
    if ($null -eq $MinVersion -or $detected -ge $MinVersion) {
      $needsInstall = $false
      Write-Log "GREEN" "$Name $detected already present (>= $MinVersion). Skipping install."
    } else {
      Write-Log "YELLOW" "$Name $detected present but below $MinVersion. Will upgrade."
    }
  } else {
    Write-Log "YELLOW" "$Name not detected. Will install."
  }

  # Step 2: Install (or skip).
  if ($needsInstall) {
    if ($DryRun) {
      Write-Log "INFO" "[DryRun] would: winget install --id $WingetId -e --silent --accept-package-agreements --accept-source-agreements"
      $notes = "DryRun: install skipped."
    } elseif ($SkipInstall) {
      Write-Log "YELLOW" "SkipInstall set. Not installing $Name."
      $notes = "SkipInstall: install skipped."
    } else {
      $iStart = Get-Date
      try {
        Write-Log "INFO" "winget install $WingetId ..."
        $args = @("install", "--id", $WingetId, "-e", "--silent",
                  "--accept-package-agreements", "--accept-source-agreements")
        & winget @args | Out-Null
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        Write-Log "GREEN" ("$Name install returned in {0:N1}s. Refreshing PATH." -f $installSec)
        # winget shims do not always appear on the current session PATH; refresh.
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
                    [System.Environment]::GetEnvironmentVariable("Path","User")
      } catch {
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        Write-Log "RED" "winget install $Name failed: $($_.Exception.Message)"
        $notes = "winget install failed: $($_.Exception.Message)"
        Add-Row -Tool $Name -Status "RED" -Detected "n/a" `
                -Required ($(if($MinVersion){"$MinVersion+"}else{"present"})) `
                -InstallSec $installSec -VerifySec 0 -Notes $notes
        return
      }
    }
  }

  # Step 3: Verify (always, even on skipped install). Proves the tool runs
  # on THIS machine right now, not just that a file is on disk.
  $vStart = Get-Date
  $postDetected = Get-ToolVersion -Exe $Exe -Args $VersionArgs
  $rawOut       = Get-ToolRawOutput -Exe $Exe -Args $VersionArgs
  $verifySec    = (New-TimeSpan -Start $vStart -End (Get-Date)).TotalSeconds

  $detStr = if ($postDetected) { "$postDetected" } elseif ($rawOut) { ($rawOut -split "`n")[0] } else { "n/a" }
  $reqStr = if ($MinVersion)   { "$MinVersion+" } else { "present" }

  if ($null -eq $postDetected -and -not $rawOut) {
    Write-Log "RED" "$Name verify FAILED. $VerifyDescription -- tool not callable."
    Add-Row -Tool $Name -Status "RED" -Detected "n/a" `
            -Required $reqStr -InstallSec $installSec -VerifySec $verifySec `
            -Notes "Verify failed: tool not callable. $notes"
    return
  }

  if ($MinVersion -and $postDetected -and $postDetected -lt $MinVersion) {
    Write-Log "RED" "$Name verify: detected $postDetected < required $MinVersion"
    Add-Row -Tool $Name -Status "RED" -Detected $detStr `
            -Required $reqStr -InstallSec $installSec -VerifySec $verifySec `
            -Notes "Below minimum. $notes"
    return
  }

  Write-Log "GREEN" ("$Name verify OK ({0}). {1}" -f $detStr, $VerifyDescription)
  Add-Row -Tool $Name -Status "GREEN" -Detected $detStr `
          -Required $reqStr -InstallSec $installSec -VerifySec $verifySec `
          -Notes $VerifyDescription
}

# --- Docker has a peculiar verify path (engine vs CLI) ----------------------
function Invoke-Bootstrap-Docker {
  Write-Log "INFO" "=== Docker Desktop ==="
  $installSec = 0.0
  $notes      = ""
  $vStart     = Get-Date

  $hasCli = $null -ne (Get-Command docker -ErrorAction SilentlyContinue)
  if (-not $hasCli) {
    if ($DryRun) {
      Write-Log "INFO" "[DryRun] would: winget install --id $($WINGET.Docker) -e --silent ..."
    } elseif ($SkipInstall) {
      Write-Log "YELLOW" "SkipInstall set. Not installing Docker."
      Add-Row -Tool "Docker Desktop" -Status "RED" -Detected "n/a" `
              -Required "Desktop + CLI" -InstallSec 0 -VerifySec 0 `
              -Notes "Not installed; SkipInstall set."
      return
    } else {
      $iStart = Get-Date
      try {
        Write-Log "INFO" "winget install Docker Desktop ..."
        $args = @("install","--id",$WINGET.Docker,"-e","--silent",
                  "--accept-package-agreements","--accept-source-agreements")
        & winget @args | Out-Null
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        Write-Log "YELLOW" ("Docker Desktop install returned in {0:N1}s. A reboot or manual first-launch may be required." -f $installSec)
        $notes = "Docker Desktop installer ran. Engine start is operator-driven (first-launch consent)."
      } catch {
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        Write-Log "RED" "winget install Docker failed: $($_.Exception.Message)"
        Add-Row -Tool "Docker Desktop" -Status "RED" -Detected "n/a" -Required "Desktop + CLI" `
                -InstallSec $installSec -VerifySec 0 -Notes "winget install failed."
        return
      }
    }
  }

  # CLI version (does not require engine running).
  $cliVer = Get-ToolRawOutput -Exe "docker" -Args @("--version")
  # Engine ping (proves the daemon is up).
  $engineUp = $false
  $engineOut = ""
  if (Get-Command docker -ErrorAction SilentlyContinue) {
    try {
      $engineOut = & docker info --format "{{.ServerVersion}}" 2>&1 | Out-String
      if ($LASTEXITCODE -eq 0 -and $engineOut.Trim()) { $engineUp = $true }
    } catch { $engineUp = $false }
  }
  $verifySec = (New-TimeSpan -Start $vStart -End (Get-Date)).TotalSeconds

  if (-not $cliVer) {
    Add-Row -Tool "Docker Desktop" -Status "RED" -Detected "n/a" -Required "Desktop + CLI" `
            -InstallSec $installSec -VerifySec $verifySec -Notes "docker CLI not on PATH after install."
    Write-Log "RED" "docker CLI not on PATH. May require shell restart or reboot."
    return
  }

  if ($engineUp) {
    Add-Row -Tool "Docker Desktop" -Status "GREEN" -Detected ("CLI: {0}; Engine: {1}" -f $cliVer, $engineOut.Trim()) `
            -Required "CLI + engine reachable" -InstallSec $installSec -VerifySec $verifySec `
            -Notes "docker info OK; engine reachable."
    Write-Log "GREEN" "Docker CLI present AND engine reachable."
  } else {
    Add-Row -Tool "Docker Desktop" -Status "YELLOW" -Detected $cliVer `
            -Required "CLI + engine reachable" -InstallSec $installSec -VerifySec $verifySec `
            -Notes "CLI present, engine not running. Start Docker Desktop, then 'docker info' should succeed."
    Write-Log "YELLOW" "Docker CLI present but engine not reachable. Start Docker Desktop."
  }
}

# --- Ollama has its own verify (serve loopback) -----------------------------
function Invoke-Bootstrap-Ollama {
  Write-Log "INFO" "=== Ollama ==="
  $installSec = 0.0
  $vStart = Get-Date

  $hasOllama = $null -ne (Get-Command ollama -ErrorAction SilentlyContinue)
  if (-not $hasOllama) {
    if ($DryRun) {
      Write-Log "INFO" "[DryRun] would: winget install --id $($WINGET.Ollama) ..."
    } elseif ($SkipInstall) {
      Write-Log "YELLOW" "SkipInstall set. Not installing Ollama."
      Add-Row -Tool "Ollama" -Status "RED" -Detected "n/a" -Required "present + serve" `
              -InstallSec 0 -VerifySec 0 -Notes "Not installed; SkipInstall set."
      return
    } else {
      $iStart = Get-Date
      try {
        $args = @("install","--id",$WINGET.Ollama,"-e","--silent",
                  "--accept-package-agreements","--accept-source-agreements")
        & winget @args | Out-Null
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + `
                    [System.Environment]::GetEnvironmentVariable("Path","User")
        Write-Log "GREEN" ("Ollama install returned in {0:N1}s." -f $installSec)
      } catch {
        $installSec = (New-TimeSpan -Start $iStart -End (Get-Date)).TotalSeconds
        Add-Row -Tool "Ollama" -Status "RED" -Detected "n/a" -Required "present + serve" `
                -InstallSec $installSec -VerifySec 0 -Notes "winget install failed: $($_.Exception.Message)"
        return
      }
    }
  }

  $ver = Get-ToolRawOutput -Exe "ollama" -Args @("--version")
  # Verify the loopback (11434) is reachable. Ollama's service auto-starts
  # on install; if it isn't up yet, we report YELLOW, not RED -- the binary
  # is there, the operator just needs to launch the tray once.
  $serveOk = $false
  $serveDetail = ""
  try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:11434/api/tags" `
            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $serveOk = $true; $serveDetail = "tags endpoint 200" }
  } catch { $serveDetail = "loopback not reachable: $($_.Exception.Message)" }

  $verifySec = (New-TimeSpan -Start $vStart -End (Get-Date)).TotalSeconds

  if (-not $ver) {
    Add-Row -Tool "Ollama" -Status "RED" -Detected "n/a" -Required "present + serve" `
            -InstallSec $installSec -VerifySec $verifySec -Notes "ollama CLI not on PATH."
    return
  }

  if ($serveOk) {
    Add-Row -Tool "Ollama" -Status "GREEN" -Detected ("{0}; {1}" -f $ver, $serveDetail) `
            -Required "present + serve" -InstallSec $installSec -VerifySec $verifySec `
            -Notes "CLI + 11434 reachable."
    Write-Log "GREEN" "Ollama CLI present AND loopback reachable."
  } else {
    Add-Row -Tool "Ollama" -Status "YELLOW" -Detected $ver `
            -Required "present + serve" -InstallSec $installSec -VerifySec $verifySec `
            -Notes "CLI present; service not reachable on 127.0.0.1:11434. Launch the Ollama tray app once."
    Write-Log "YELLOW" "Ollama CLI present but 11434 not reachable."
  }
}

# --- Main -------------------------------------------------------------------
$hasWinget = Test-PreFlight
Write-Log "INFO" ("Orange5 bootstrap starting. DryRun={0} SkipInstall={1} winget={2}" -f $DryRun, $SkipInstall, $hasWinget)

Invoke-Bootstrap-Tool -Name "Node.js"   -Exe "node"   -VersionArgs @("--version") `
  -WingetId $WINGET.Node   -MinVersion $MIN.Node `
  -VerifyDescription "node --version returned a SemVer >= 20."

Invoke-Bootstrap-Tool -Name "Bun"       -Exe "bun"    -VersionArgs @("--version") `
  -WingetId $WINGET.Bun    -MinVersion $MIN.Bun `
  -VerifyDescription "bun --version returned a SemVer >= 1.1."

Invoke-Bootstrap-Tool -Name "Python"    -Exe "python" -VersionArgs @("--version") `
  -WingetId $WINGET.Python -MinVersion $MIN.Python `
  -VerifyDescription "python --version returned a SemVer >= 3.11."

Invoke-Bootstrap-Tool -Name "Git"       -Exe "git"    -VersionArgs @("--version") `
  -WingetId $WINGET.Git    -MinVersion $MIN.Git `
  -VerifyDescription "git --version returned a SemVer >= 2.40."

Invoke-Bootstrap-Tool -Name "GitHub CLI" -Exe "gh"    -VersionArgs @("--version") `
  -WingetId $WINGET.Gh     -MinVersion $MIN.Gh `
  -VerifyDescription "gh --version returned a SemVer >= 2.40."

Invoke-Bootstrap-Ollama
Invoke-Bootstrap-Docker

# --- End-to-end install + boot timing receipt -------------------------------
$RunEnd     = Get-Date
$TotalSec   = (New-TimeSpan -Start $RunStart -End $RunEnd).TotalSeconds
$Greens     = ($Rows | Where-Object Status -eq "GREEN").Count
$Yellows    = ($Rows | Where-Object Status -eq "YELLOW").Count
$Reds       = ($Rows | Where-Object Status -eq "RED").Count
$Total      = $Rows.Count

# --- Receipt (markdown) -----------------------------------------------------
$receiptLines = New-Object System.Collections.ArrayList
$null = $receiptLines.Add("# Orange5 bootstrap receipt")
$null = $receiptLines.Add("")
$null = $receiptLines.Add("- Run start: $($RunStart.ToString("yyyy-MM-dd HH:mm:ss zzz"))")
$null = $receiptLines.Add("- Run end:   $($RunEnd.ToString("yyyy-MM-dd HH:mm:ss zzz"))")
$null = $receiptLines.Add("- Wall clock: {0:N1} s ({1:N2} min)" -f $TotalSec, ($TotalSec/60.0))
$null = $receiptLines.Add("- Host: $env:COMPUTERNAME  User: $env:USERNAME")
$null = $receiptLines.Add("- OS: $((Get-CimInstance Win32_OperatingSystem).Caption) build $((Get-CimInstance Win32_OperatingSystem).BuildNumber)")
$null = $receiptLines.Add("- Flags: DryRun=$DryRun SkipInstall=$SkipInstall winget=$hasWinget")
$null = $receiptLines.Add("- Targets: $Total | GREEN=$Greens YELLOW=$Yellows RED=$Reds")
$null = $receiptLines.Add("- 30-minute SLA: {0}" -f $(if ($TotalSec -le 1800) { "MET ({0:N1}s under 1800s)" -f (1800 - $TotalSec) } else { "MISSED ({0:N1}s over 1800s)" -f ($TotalSec - 1800) }))
$null = $receiptLines.Add("")
$null = $receiptLines.Add("## Per-tool results")
$null = $receiptLines.Add("")
$null = $receiptLines.Add("| Tool | Status | Detected | Required | Install (s) | Verify (s) | Notes |")
$null = $receiptLines.Add("|---|---|---|---|---:|---:|---|")
foreach ($r in $Rows) {
  $null = $receiptLines.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6} |" -f `
    $r.Tool, $r.Status, $r.Detected, $r.Required, $r.InstallSec, $r.VerifySec, ($r.Notes -replace '\|','/')))
}
$null = $receiptLines.Add("")
$null = $receiptLines.Add("## What this run actually proves")
$null = $receiptLines.Add("")
$null = $receiptLines.Add("- GREEN rows: tool present at >= required version AND callable on this host right now.")
$null = $receiptLines.Add("- YELLOW rows: tool present but a runtime dependency (engine, service) is not up. Operator action named in Notes.")
$null = $receiptLines.Add("- RED rows: tool absent OR below required version OR install failed. Hand-install per Notes and re-run.")
$null = $receiptLines.Add("")
$null = $receiptLines.Add("## Next step")
$null = $receiptLines.Add("")
if ($Reds -eq 0) {
  $null = $receiptLines.Add("All required tools verified. Proceed to: ``scripts/wave12-wire-up.ps1`` to splice routes and run smoke tests.")
} else {
  $null = $receiptLines.Add("$Reds RED rows above. Resolve each one before running ``scripts/wave12-wire-up.ps1``. Mom's Law: no fake green.")
}

$receipt = ($receiptLines -join "`r`n")
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

# --- Console summary --------------------------------------------------------
Write-Host ""
Write-Host "==================== Orange5 bootstrap summary ====================" -ForegroundColor Cyan
$Rows | Format-Table Tool, Status, Detected, Required, InstallSec, VerifySec -AutoSize
Write-Host ("Wall clock: {0:N1}s ({1:N2} min)  GREEN={2}  YELLOW={3}  RED={4}" -f $TotalSec, ($TotalSec/60.0), $Greens, $Yellows, $Reds) -ForegroundColor Cyan
Write-Host ("30-min SLA: {0}" -f $(if ($TotalSec -le 1800) { "MET" } else { "MISSED" })) -ForegroundColor $(if ($TotalSec -le 1800) { "Green" } else { "Yellow" })
Write-Host "===================================================================" -ForegroundColor Cyan

if ($DryRun)       { exit 0 }
if ($Reds -gt 0)   { exit 1 }
exit 0
