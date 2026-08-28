# wave12-wire-up.ps1
# Master wire-up script for Orange5 Wave 1+2 operator-side activation.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- no theater, no silent fallback, no take-down. Real
#   receipts only. If a step cannot prove itself green, it says so loud.
# Frontier-Isolation: the gateway at 127.0.0.1:1337 must remain the only door
#   reachable by the frontier. If wire-up would leave the operator with no
#   gateway, the script rolls forward to the prior state instead of dying.
#
# Phases:
#   1. Install npm dependencies in the correct node_modules boundaries.
#   2. Splice 14 route-registration calls into 06-ORANGELLM/server/index.mjs
#      (idempotent, sentinel-fenced).
#   3. Verify gateway boots and answers /healthz; auto-rollback on failure.
#   4. Run npm run build smoke for 02-APP Atomic Orange shell.
#   5. Run smoke-test.mjs files for new Wave 1+2 subsystems.
#   6. Emit a markdown receipt + green/red tally.
#
# Flags:
#   -DryRun   : print every planned action, mutate nothing on disk, run no
#               installs, no splice, no restart, no tests. Exits 0.
#   -Force    : required for any destructive step. Today the only destructive
#               step is SIGTERM-ing a running gateway PID during phase 3.
#               Without -Force the gateway restart is SKIPPED with a yellow
#               warning rather than executed.
#   -SkipInstall    : skip phase 1 (assume deps already there).
#   -SkipBuildSmoke : skip phase 4 (02-APP tsc+vite can be slow).
#   -SkipTests      : skip phase 5 (smoke-tests).
#   -Verbose        : extra log lines per phase.
#
# Exit codes:
#   0  success: everything green or yellow-warning-but-not-blocking.
#   1  one or more phases failed; receipt still emitted with red rows.
#   2  fatal pre-flight (paths missing, can't write receipt dir, etc.).

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [switch]$SkipInstall,
  [switch]$SkipBuildSmoke,
  [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths (anchored, never relative) ---------------------------------------
$ORANGE5_ROOT  = "C:\AtomEons\Orange5"
$ORANGELLM_DIR = Join-Path $ORANGE5_ROOT "06-ORANGELLM"
$INDEX_PATH    = Join-Path $ORANGELLM_DIR "server\index.mjs"
$CONTROL_PLANE_RECEIPTS = Join-Path $ORANGE5_ROOT "06-CONTROL-PLANE\receipts"
$APP_DIR       = Join-Path $ORANGE5_ROOT "02-APP"
$RECEIPT_DIR   = Join-Path $ORANGE5_ROOT "10-RECEIPTS\orange5-build"
$DATE_STAMP    = Get-Date -Format "yyyy-MM-dd"
$TS_LOG        = Get-Date -Format "HH:mm:ss"
$RECEIPT_PATH  = Join-Path $RECEIPT_DIR ("{0}-wave12-wired.md" -f $DATE_STAMP)

$GATEWAY_PORT  = 1337
$GATEWAY_HEALTHZ = "http://127.0.0.1:{0}/healthz" -f $GATEWAY_PORT

# --- Splice sentinels (idempotent) ------------------------------------------
$SENTINEL_IMPORT_BEGIN = "// >>> WAVE12_WIRE_UP_IMPORTS_BEGIN <<<"
$SENTINEL_IMPORT_END   = "// >>> WAVE12_WIRE_UP_IMPORTS_END <<<"
$SENTINEL_REG_BEGIN    = "// >>> WAVE12_WIRE_UP_REGISTRATIONS_BEGIN <<<"
$SENTINEL_REG_END      = "// >>> WAVE12_WIRE_UP_REGISTRATIONS_END <<<"
$SENTINEL_DISPATCH_BEGIN = "// >>> WAVE12_WIRE_UP_DISPATCH_BEGIN <<<"
$SENTINEL_DISPATCH_END   = "// >>> WAVE12_WIRE_UP_DISPATCH_END <<<"

# --- Tally ------------------------------------------------------------------
$Script:Steps = @()  # @{ Phase; Name; Status (green|red|yellow|skip); Detail }

function Add-Step {
  param(
    [string]$Phase,
    [string]$Name,
    [string]$Status,
    [string]$Detail = ""
  )
  $Script:Steps += [pscustomobject]@{
    Phase  = $Phase
    Name   = $Name
    Status = $Status
    Detail = $Detail
    At     = (Get-Date -Format "HH:mm:ss")
  }
  $color = switch ($Status) {
    "green"  { "Green" }
    "red"    { "Red" }
    "yellow" { "Yellow" }
    "skip"   { "DarkGray" }
    default  { "Gray" }
  }
  $tag = "[{0}][{1}]" -f $Phase, $Status.ToUpper()
  Write-Host ("{0} {1}" -f $tag, $Name) -ForegroundColor $color
  if ($Detail) {
    Write-Host ("    {0}" -f $Detail) -ForegroundColor DarkGray
  }
}

function Banner {
  param([string]$Text)
  Write-Host ""
  Write-Host ("=== {0} ===" -f $Text) -ForegroundColor Cyan
}

function Get-FileSha256 {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $null }
  try {
    return (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  } catch { return $null }
}

# Write UTF-8 WITHOUT BOM. Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
# adds a BOM, which makes `node --check` choke on the shebang line. We must
# match the encoding of the original files this script edits (plain UTF-8).
function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $enc)
}

# --- Pre-flight -------------------------------------------------------------

Banner "WAVE 1+2 WIRE-UP (Orange5) -- operator-side activation"
Write-Host ("DryRun       : {0}" -f $DryRun)
Write-Host ("Force        : {0}" -f $Force)
Write-Host ("SkipInstall  : {0}" -f $SkipInstall)
Write-Host ("SkipBuild    : {0}" -f $SkipBuildSmoke)
Write-Host ("SkipTests    : {0}" -f $SkipTests)
Write-Host ("Receipt path : {0}" -f $RECEIPT_PATH)
Write-Host ""

# Required paths must exist.
$preflightMissing = @()
foreach ($p in @($ORANGE5_ROOT, $ORANGELLM_DIR, $INDEX_PATH, $APP_DIR)) {
  if (-not (Test-Path $p)) { $preflightMissing += $p }
}
if ($preflightMissing.Count -gt 0) {
  Write-Host "Preflight FAIL -- missing required paths:" -ForegroundColor Red
  $preflightMissing | ForEach-Object { Write-Host ("  - {0}" -f $_) -ForegroundColor Red }
  exit 2
}

if (-not (Test-Path $RECEIPT_DIR)) {
  if ($DryRun) {
    Write-Host ("[dry-run] would mkdir {0}" -f $RECEIPT_DIR) -ForegroundColor DarkGray
  } else {
    try { New-Item -ItemType Directory -Force -Path $RECEIPT_DIR | Out-Null }
    catch {
      Write-Host ("Preflight FAIL -- cannot create receipt dir: {0}" -f $_.Exception.Message) -ForegroundColor Red
      exit 2
    }
  }
}

# Capture pre-splice hash for receipt.
$IndexShaBefore = Get-FileSha256 -Path $INDEX_PATH

# =============================================================================
# PHASE 1 -- npm install
# =============================================================================

Banner "PHASE 1 -- npm install"

function Ensure-PackageJson {
  param(
    [string]$Dir,
    [string]$Name,
    [string[]]$Deps
  )
  $pkgPath = Join-Path $Dir "package.json"
  if (Test-Path $pkgPath) { return $pkgPath }
  if ($DryRun) {
    Add-Step "1" ("create stub package.json {0}" -f $pkgPath) "skip" "(dry-run)"
    return $pkgPath
  }
  $depsObj = @{}
  foreach ($d in $Deps) { $depsObj[$d] = "*" }  # let npm resolve latest compatible
  $obj = [ordered]@{
    name = $Name
    private = $true
    version = "0.0.1"
    type = "module"
    dependencies = $depsObj
  }
  $json = $obj | ConvertTo-Json -Depth 5
  Write-Utf8NoBom -Path $pkgPath -Content $json
  Add-Step "1" ("created stub package.json {0}" -f $pkgPath) "green"
  return $pkgPath
}

function Invoke-NpmInstall {
  param(
    [string]$Dir,
    [string[]]$Packages,
    [string]$Label
  )
  if ($SkipInstall) {
    Add-Step "1" ("install {0}" -f $Label) "skip" "-SkipInstall set"
    return
  }
  if (-not (Test-Path $Dir)) {
    Add-Step "1" ("install {0}" -f $Label) "red" ("missing dir: {0}" -f $Dir)
    return
  }
  if ($DryRun) {
    Add-Step "1" ("npm install {0} in {1}" -f ($Packages -join " "), $Dir) "skip" "(dry-run)"
    return
  }

  $pkgPath = Join-Path $Dir "package.json"
  if (-not (Test-Path $pkgPath)) {
    Ensure-PackageJson -Dir $Dir -Name ("orange5-{0}" -f ($Label -replace "[^a-z0-9]+","-")) -Deps $Packages | Out-Null
  }

  Push-Location $Dir
  try {
    # Build the arg list. npm install <pkgs...> --save --no-audit --no-fund --loglevel=error
    $args = @("install") + $Packages + @("--save", "--no-audit", "--no-fund", "--loglevel=error")
    Write-Host ("    npm {0}" -f ($args -join " ")) -ForegroundColor DarkGray
    $proc = Start-Process -FilePath "npm.cmd" -ArgumentList $args -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $env:TEMP "npm-out.log") `
      -RedirectStandardError  (Join-Path $env:TEMP "npm-err.log")
    if ($proc.ExitCode -eq 0) {
      Add-Step "1" ("install {0}" -f $Label) "green" ($Packages -join ", ")
    } else {
      $errTail = ""
      try { $errTail = (Get-Content (Join-Path $env:TEMP "npm-err.log") -Tail 5 -ErrorAction Stop) -join " | " }
      catch {}
      Add-Step "1" ("install {0}" -f $Label) "red" ("npm exit {0} :: {1}" -f $proc.ExitCode, $errTail)
    }
  } catch {
    Add-Step "1" ("install {0}" -f $Label) "red" $_.Exception.Message
  } finally {
    Pop-Location
  }
}

# 1a. better-sqlite3 in 06-ORANGELLM
Invoke-NpmInstall -Dir $ORANGELLM_DIR -Packages @("better-sqlite3") `
  -Label "06-ORANGELLM (better-sqlite3)"

# 1b. better-sqlite3 in 06-CONTROL-PLANE -- operator brief said
# "06-CONTROL-PLANE"; the only existing package.json under that branch is at
# 06-CONTROL-PLANE/receipts/. Install there (already declares the dep; this
# is the idempotent re-resolve).
Invoke-NpmInstall -Dir $CONTROL_PLANE_RECEIPTS -Packages @("better-sqlite3") `
  -Label "06-CONTROL-PLANE/receipts (better-sqlite3)"

# 1c. Mirage adapter deps at Orange5 root
Invoke-NpmInstall -Dir $ORANGE5_ROOT `
  -Packages @("pg","googleapis","ioredis","@octokit/rest","@slack/web-api") `
  -Label "Orange5 root (Mirage adapter deps)"

# =============================================================================
# PHASE 2 -- splice index.mjs
# =============================================================================

Banner "PHASE 2 -- splice gateway routes into 06-ORANGELLM/server/index.mjs"

# Read once.
$indexContent = Get-Content -Path $INDEX_PATH -Raw -Encoding UTF8

# Build the splice payloads in three blocks: imports, registrations (called
# right after createServer), and dispatch (extra `if`s inside the request
# handler for the older dispatch-style routes: graph + receipts).

$importBlock = @"
$SENTINEL_IMPORT_BEGIN
// Wave 1+2 route modules -- added by scripts/wave12-wire-up.ps1.
// Each register*Routes() attaches via server.prependListener("request", ...).
// Do not edit between sentinels; re-run wave12-wire-up.ps1 to update.
import { registerHermesRoutes }              from "./routes/hermes.mjs";
import { registerMemoryRoutes }              from "./routes/memory.mjs";
import { registerVisualRoutes }              from "./routes/visual.mjs";
import { registerGraphRoutes, dispatchGraph, isGraphPath }
                                              from "./routes/graph.mjs";
import { registerAtomSmasherRoutes }         from "./routes/atomsmasher.mjs";
import { registerAirCodecRoutes }            from "./routes/atomsmasher-air.mjs";
import { registerCartridgesRoutes }          from "./routes/atomsmasher-cartridges.mjs";
import { registerCompressionDebtRoutes }     from "./routes/atomsmasher-compression-debt.mjs";
import { registerPromotionRoutes }           from "./routes/promotion.mjs";
import { registerReceiptsRoutes, dispatchReceipts, isReceiptsPath }
                                              from "./routes/receipts.mjs";
import { handleAECodeCompile, handleAECodeMissionStart, handleAECodeMissionGet, handleAELangRoute, matchAECodeRoute }
                                              from "./routes/aecode.mjs";
import { handleCurrent as handleFlowCurrent, handleState as handleFlowState, handleDeltas as handleFlowDeltas, handleOrder as handleFlowOrder, handleEnduranceStatus, isFlowPath, isFlowRouteAllowed, FLOW_ALLOWED }
                                              from "./routes/flow.mjs";
import { registerMisfitRoutes }              from "./routes/misfit.mjs";
$SENTINEL_IMPORT_END
"@

$registrationBlock = @"
$SENTINEL_REG_BEGIN
// Wave 1+2 route registrations -- added by scripts/wave12-wire-up.ps1.
// Self-wire style modules attach themselves to the server above. AECode and
// Flow are dispatched inline by the main request handler (see DISPATCH block).
try {
  registerHermesRoutes(server);
  registerMemoryRoutes(server);
  registerVisualRoutes(server);
  registerGraphRoutes(server);
  registerAtomSmasherRoutes(server);
  registerAirCodecRoutes(server);
  registerCartridgesRoutes(server);
  registerCompressionDebtRoutes(server);
  registerPromotionRoutes(server);
  registerReceiptsRoutes(server);
  registerMisfitRoutes(server);
  console.log("[orangellm] wave-12 routes registered (hermes, memory, visual, graph, atomsmasher x4, promotion, receipts, misfit)");
} catch (err) {
  console.error("[orangellm] wave-12 route registration FAILED:", err);
  throw err;
}
$SENTINEL_REG_END
"@

# Dispatch block -- sits inside the createServer() request handler, BEFORE the
# 404. graph + receipts + aecode + flow each return a result-or-null; if not
# null, we serialize it and stop.
$dispatchBlock = @"
$SENTINEL_DISPATCH_BEGIN
    // Wave 1+2 dispatch -- added by scripts/wave12-wire-up.ps1.
    // Graph (dispatch-style register).
    if (isGraphPath(path) && server._graphDispatch) {
      const result = await server._graphDispatch(req, url, url.searchParams, null);
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
    // Receipts (read-only).
    if (isReceiptsPath(path)) {
      const result = await dispatchReceipts(req, url);
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
    // AECode + AELang.
    const aecodeMatch = matchAECodeRoute({ method, path });
    if (aecodeMatch) {
      let result;
      if (aecodeMatch.handler === "compile") {
        result = await handleAECodeCompile(await readBody(req));
      } else if (aecodeMatch.handler === "mission_start") {
        result = await handleAECodeMissionStart(await readBody(req));
      } else if (aecodeMatch.handler === "mission_get") {
        result = await handleAECodeMissionGet(aecodeMatch.params?.id);
      } else if (aecodeMatch.handler === "aelang_route") {
        result = await handleAELangRoute(await readBody(req));
      }
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
    // Flow + Endurance.
    if (isFlowPath(path) || path === "/v1/endurance/status") {
      if (!isFlowRouteAllowed(method, path) && path !== "/v1/endurance/status") {
        return errorResponse(res, "Flow route not allowed", 405);
      }
      let result = null;
      if (method === "GET"  && path === "/v1/flow/current")      result = handleFlowCurrent();
      else if (method === "GET"  && path === "/v1/flow/state")    result = handleFlowState(url.searchParams);
      else if (method === "GET"  && path === "/v1/flow/deltas")   result = handleFlowDeltas(url.searchParams);
      else if (method === "POST" && path === "/v1/flow/order")    result = handleFlowOrder(await readBody(req));
      else if (method === "GET"  && path === "/v1/endurance/status") result = handleEnduranceStatus();
      if (result) {
        const status = result._ae_http_status || 200;
        delete result._ae_http_status;
        return jsonResponse(res, result, status);
      }
    }
$SENTINEL_DISPATCH_END
"@

# Detect already-spliced.
$haveImport   = $indexContent.Contains($SENTINEL_IMPORT_BEGIN)
$haveReg      = $indexContent.Contains($SENTINEL_REG_BEGIN)
$haveDispatch = $indexContent.Contains($SENTINEL_DISPATCH_BEGIN)

if ($haveImport -and $haveReg -and $haveDispatch) {
  Add-Step "2" "splice index.mjs" "skip" "already wired (sentinels present)"
} else {
  if ($DryRun) {
    Add-Step "2" "splice index.mjs" "skip" "(dry-run) would inject 3 sentinel-fenced blocks"
  } else {
    # Build the new file from the original, working on a copy first so we can
    # roll back. The original is preserved at <path>.pre-wave12 the first
    # time we splice; subsequent runs are no-ops (skip branch above).
    $backupPath = "{0}.pre-wave12" -f $INDEX_PATH
    if (-not (Test-Path $backupPath)) {
      Copy-Item -Path $INDEX_PATH -Destination $backupPath -Force
      Add-Step "2" "backed up original index.mjs" "green" $backupPath
    }

    $newContent = $indexContent

    # ---- 1) IMPORT BLOCK -----------------------------------------------
    # Insert just after the last existing `import ... from "..."` line.
    if (-not $haveImport) {
      $lines = $newContent -split "`r?`n"
      $lastImportIdx = -1
      for ($i = 0; $i -lt $lines.Length; $i++) {
        if ($lines[$i] -match '^\s*import\s.+from\s+["''].+["''];?\s*$') {
          $lastImportIdx = $i
        }
      }
      if ($lastImportIdx -lt 0) {
        Add-Step "2" "splice imports" "red" "no existing import lines found in index.mjs"
        throw "splice anchor not found"
      }
      $before = $lines[0..$lastImportIdx] -join "`r`n"
      $after  = if ($lastImportIdx + 1 -lt $lines.Length) { $lines[($lastImportIdx + 1)..($lines.Length - 1)] -join "`r`n" } else { "" }
      $newContent = $before + "`r`n" + $importBlock + "`r`n" + $after
    }

    # ---- 2) REGISTRATION BLOCK -----------------------------------------
    # Insert AFTER `const server = createServer(...)`  and the closing `});`
    # of that block (i.e. before `server.listen(`).
    if (-not $haveReg) {
      $idx = $newContent.IndexOf("server.listen(")
      if ($idx -lt 0) {
        Add-Step "2" "splice registrations" "red" "server.listen( anchor not found in index.mjs"
        throw "splice anchor not found"
      }
      $newContent = $newContent.Substring(0, $idx) + $registrationBlock + "`r`n`r`n" + $newContent.Substring($idx)
    }

    # ---- 3) DISPATCH BLOCK ---------------------------------------------
    # Insert just before `return errorResponse(res, ``Not found...`)`.
    if (-not $haveDispatch) {
      # Look for the 404 fallback inside the request handler.
      $needle = 'return errorResponse(res, `Not found:'
      $idx = $newContent.IndexOf($needle)
      if ($idx -lt 0) {
        # Try the single-quote variant used in the original file.
        $needle = 'return errorResponse(res, `Not found: '
        $idx = $newContent.IndexOf($needle)
      }
      if ($idx -lt 0) {
        Add-Step "2" "splice dispatch" "red" "404 anchor not found in index.mjs"
        throw "splice anchor not found"
      }
      $newContent = $newContent.Substring(0, $idx) + $dispatchBlock + "`r`n    " + $newContent.Substring($idx)
    }

    # ---- Validate on a copy with `node --check` BEFORE replacing live --
    $tmp = Join-Path $env:TEMP ("orange5-index-{0}.mjs" -f ([guid]::NewGuid().ToString("N")))
    Write-Utf8NoBom -Path $tmp -Content $newContent
    $check = Start-Process -FilePath "node.exe" -ArgumentList @("--check", $tmp) `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput (Join-Path $env:TEMP "node-check-out.log") `
      -RedirectStandardError  (Join-Path $env:TEMP "node-check-err.log")
    if ($check.ExitCode -ne 0) {
      $errTail = ""
      try { $errTail = (Get-Content (Join-Path $env:TEMP "node-check-err.log") -Tail 8) -join " | " } catch {}
      Add-Step "2" "node --check spliced index.mjs" "red" $errTail
      Remove-Item $tmp -Force -ErrorAction SilentlyContinue
      throw "spliced index.mjs failed syntax check; live file not touched"
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue

    # Live replace.
    Write-Utf8NoBom -Path $INDEX_PATH -Content $newContent
    Add-Step "2" "splice index.mjs (3 sentinel blocks)" "green" ("imports={0} regs={1} dispatch={2}" -f (-not $haveImport), (-not $haveReg), (-not $haveDispatch))
  }
}

$IndexShaAfterSplice = Get-FileSha256 -Path $INDEX_PATH

# =============================================================================
# PHASE 3 -- verify gateway still starts (no-take-down rollback)
# =============================================================================

Banner "PHASE 3 -- verify gateway boots and answers /healthz"

function Test-GatewayAlive {
  # The /healthz handler probes upstream smart-skinny + fatty before
  # returning, which can take 2-4 seconds even when everything is healthy.
  # Default per-probe timeout is generous; the WAIT loop is the budgeter.
  param([int]$TimeoutSec = 5)
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec $TimeoutSec -Uri $GATEWAY_HEALTHZ -ErrorAction Stop
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

function Get-GatewayPid {
  # Find the node.exe process whose command line points at our index.mjs.
  $candidates = @()
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop
    foreach ($p in $procs) {
      if ($p.CommandLine -and $p.CommandLine -like ("*{0}*" -f $INDEX_PATH.Replace("\","\\"))) {
        $candidates += $p.ProcessId
      }
      elseif ($p.CommandLine -and $p.CommandLine -like "*06-ORANGELLM*index.mjs*") {
        $candidates += $p.ProcessId
      }
    }
  } catch {}
  return $candidates
}

function Stop-GatewayPid {
  param([int]$Pid)
  # SIGTERM equivalent on Windows: try graceful CloseMainWindow first, fall
  # back to Stop-Process. We never -Force kill without operator -Force flag.
  try {
    $proc = Get-Process -Id $Pid -ErrorAction Stop
    $proc.CloseMainWindow() | Out-Null
    Start-Sleep -Milliseconds 1500
    if (-not $proc.HasExited) { Stop-Process -Id $Pid -Force -ErrorAction Stop }
    return $true
  } catch {
    return $false
  }
}

function Start-Gateway {
  param([string]$LogFile)
  return Start-Process -FilePath "node.exe" -ArgumentList @("`"$INDEX_PATH`"") `
    -WorkingDirectory $ORANGELLM_DIR `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError  ($LogFile -replace "\.log$",".err.log")
}

function Wait-Healthz {
  # Total wall-time budget. Each probe gives the handler up to 4s to finish
  # the upstream pre-check; between probes we sleep 1s. So ~5s/round; a 20s
  # budget gives ~4 real probes. Operator wants honest answers, not
  # phantom-failures because we polled too fast.
  param([int]$TimeoutSec = 20)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-GatewayAlive -TimeoutSec 4) { return $true }
    Start-Sleep -Milliseconds 1000
  }
  return $false
}

# Wait until port 1337 is unbound. Crashed gateways can hold the port in
# TIME_WAIT or LISTEN briefly even after the node process exits. We can NOT
# launch a replacement gateway while the port is held, or it crashes with
# EADDRINUSE and the operator is left with nothing.
function Wait-PortReleased {
  param([int]$Port = 1337, [int]$TimeoutSec = 8)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    $tcp = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
    # Treat only LISTEN state as "held"; TIME_WAIT/CLOSE_WAIT are fine on the
    # client side and don't block a new bind.
    $held = @($tcp | Where-Object { $_.State -eq 'Listen' }).Count
    if ($held -eq 0) { return $true }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

if ($DryRun) {
  Add-Step "3" "verify gateway restart" "skip" "(dry-run)"
} else {
  $oldPids = Get-GatewayPid
  $wasAlive = Test-GatewayAlive -TimeoutSec 5

  if ($wasAlive -and (-not $Force)) {
    Add-Step "3" "gateway restart" "yellow" "gateway running; pass -Force to restart and re-verify. Splice is on disk but unloaded."
  } else {
    $logDir = Join-Path $env:USERPROFILE "OrangeBox-Data\logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $logFile = Join-Path $logDir ("orange5-orangellm-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

    # Stop old, if any.
    if ($wasAlive) {
      foreach ($p in $oldPids) {
        $stopped = Stop-GatewayPid -Pid $p
        Add-Step "3" ("stop old gateway pid {0}" -f $p) ($(if($stopped){"green"}else{"yellow"})) ""
      }
    }

    # Wait for port to be released before bringing the new one up -- both for
    # the "old was running" and the "stale TIME_WAIT" cases. Without this we
    # race EADDRINUSE and the new process dies on bind.
    $released = Wait-PortReleased -Port $GATEWAY_PORT -TimeoutSec 8
    if (-not $released) {
      Add-Step "3" "port $GATEWAY_PORT still held" "red" "cannot launch new gateway; another process owns the port"
    } else {
      # Start new gateway.
      $newProc = Start-Gateway -LogFile $logFile
      $alive = Wait-Healthz -TimeoutSec 20

      if ($alive) {
        Add-Step "3" "new gateway live on /healthz" "green" ("pid={0} log={1}" -f $newProc.Id, $logFile)
      } else {
        # Mom's Law no-take-down: kill the new (broken) gateway, restore the
        # previous index.mjs from backup, wait for the port to free, then
        # bring the original back. If even that fails, scream loud so the
        # operator knows there is NO gateway and goes looking at logs.
        Add-Step "3" "new gateway failed healthz" "red" ("pid={0} log={1}" -f $newProc.Id, $logFile)
        try { Stop-Process -Id $newProc.Id -Force -ErrorAction Stop } catch {}

        $backupPath = "{0}.pre-wave12" -f $INDEX_PATH
        if (Test-Path $backupPath) {
          Copy-Item -Path $backupPath -Destination $INDEX_PATH -Force
          Add-Step "3" "rollback index.mjs from backup" "yellow" $backupPath

          # Wait for the dead process to release the port. Without this the
          # rollback start races EADDRINUSE and we report a phantom failure.
          $rbReleased = Wait-PortReleased -Port $GATEWAY_PORT -TimeoutSec 10
          if (-not $rbReleased) {
            Add-Step "3" "rollback port wait" "red" "port $GATEWAY_PORT did not release in 10s"
          } else {
            $restoreProc = Start-Gateway -LogFile (Join-Path $logDir "orange5-orangellm-rollback.log")
            $restoreAlive = Wait-Healthz -TimeoutSec 25
            if ($restoreAlive) {
              Add-Step "3" "rollback gateway live" "yellow" ("original gateway restored pid={0}; investigate splice failure" -f $restoreProc.Id)
            } else {
              Add-Step "3" "rollback gateway also failed" "red" "operator has NO gateway -- investigate logs immediately"
            }
          }
        } else {
          Add-Step "3" "no backup file to restore" "red" "operator has NO gateway -- investigate logs immediately"
        }
      }
    }
  }
}

# =============================================================================
# PHASE 4 -- npm run build smoke for 02-APP
# =============================================================================

Banner "PHASE 4 -- 02-APP build smoke"

if ($SkipBuildSmoke) {
  Add-Step "4" "02-APP build smoke" "skip" "-SkipBuildSmoke set"
} elseif ($DryRun) {
  Add-Step "4" "02-APP build smoke" "skip" "(dry-run)"
} else {
  Push-Location $APP_DIR
  try {
    $outLog = Join-Path $env:TEMP "orange5-app-build-out.log"
    $errLog = Join-Path $env:TEMP "orange5-app-build-err.log"
    $proc = Start-Process -FilePath "npm.cmd" -ArgumentList @("run","build","--silent") `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc.ExitCode -eq 0) {
      Add-Step "4" "02-APP build smoke" "green" "vite + tsc clean"
    } else {
      $errTail = ""
      try { $errTail = (Get-Content $errLog -Tail 10) -join " | " } catch {}
      Add-Step "4" "02-APP build smoke" "red" ("exit {0} :: {1}" -f $proc.ExitCode, $errTail)
    }
  } catch {
    Add-Step "4" "02-APP build smoke" "red" $_.Exception.Message
  } finally {
    Pop-Location
  }
}

# =============================================================================
# PHASE 5 -- subsystem smoke tests
# =============================================================================

Banner "PHASE 5 -- subsystem smoke tests"

$SmokeTargets = @(
  @{ Name="atomsmasher/air-codec";       Path="$ORANGE5_ROOT\12-ATOMSMASHER\air-codec\smoke-test.mjs";       Cwd="$ORANGE5_ROOT\12-ATOMSMASHER\air-codec" },
  @{ Name="atomsmasher/equation-store";  Path="$ORANGE5_ROOT\12-ATOMSMASHER\equation-store\smoke-test.mjs";  Cwd="$ORANGE5_ROOT\12-ATOMSMASHER\equation-store" },
  @{ Name="atomsmasher/commitment-atoms";Path="$ORANGE5_ROOT\12-ATOMSMASHER\commitment-atoms\smoke-test.mjs";Cwd="$ORANGE5_ROOT\12-ATOMSMASHER\commitment-atoms" },
  @{ Name="atomsmasher/compression-debt";Path="$ORANGE5_ROOT\12-ATOMSMASHER\compression-debt\smoke-test.mjs";Cwd="$ORANGE5_ROOT\12-ATOMSMASHER\compression-debt" },
  @{ Name="atomsmasher/canon-pressure";  Path="$ORANGE5_ROOT\12-ATOMSMASHER\canon-pressure\smoke-test.mjs";  Cwd="$ORANGE5_ROOT\12-ATOMSMASHER\canon-pressure" },
  @{ Name="control-plane/promotion-gate";Path="$ORANGE5_ROOT\04-CONTROL-PLANE\promotion-gate\engine.test.mjs";Cwd="$ORANGE5_ROOT\04-CONTROL-PLANE\promotion-gate" },
  @{ Name="control-plane/receipts (endurance.test)";Path="$ORANGE5_ROOT\06-CONTROL-PLANE\receipts\endurance.test.mjs";Cwd="$ORANGE5_ROOT\06-CONTROL-PLANE\receipts" }
)

$smokePass = 0; $smokeFail = 0; $smokeSkip = 0

function Invoke-NodeTest {
  param([string]$Name, [string]$Path, [string]$Cwd)
  if (-not (Test-Path $Path)) {
    Add-Step "5" $Name "skip" "missing: $Path"
    $Script:smokeSkip++; return
  }
  if ($SkipTests) { Add-Step "5" $Name "skip" "-SkipTests set"; $Script:smokeSkip++; return }
  if ($DryRun)    { Add-Step "5" $Name "skip" "(dry-run)";       $Script:smokeSkip++; return }

  # node --test for .test.mjs files; plain node for smoke-test.mjs.
  $args = if ($Path -match "\.test\.mjs$") { @("--test", $Path) } else { @($Path) }
  $outLog = Join-Path $env:TEMP ("smoke-{0}.out.log" -f ($Name -replace "[^a-zA-Z0-9]+","-"))
  $errLog = Join-Path $env:TEMP ("smoke-{0}.err.log" -f ($Name -replace "[^a-zA-Z0-9]+","-"))
  try {
    $proc = Start-Process -FilePath "node.exe" -ArgumentList $args `
      -WorkingDirectory $Cwd `
      -NoNewWindow -Wait -PassThru `
      -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    if ($proc.ExitCode -eq 0) {
      Add-Step "5" $Name "green" ""
      $Script:smokePass++
    } else {
      $tail = ""
      try { $tail = (Get-Content $errLog -Tail 5 -ErrorAction Stop) -join " | " } catch {}
      if (-not $tail) { try { $tail = (Get-Content $outLog -Tail 5 -ErrorAction Stop) -join " | " } catch {} }
      Add-Step "5" $Name "red" ("exit {0} :: {1}" -f $proc.ExitCode, $tail)
      $Script:smokeFail++
    }
  } catch {
    Add-Step "5" $Name "red" $_.Exception.Message
    $Script:smokeFail++
  }
}

foreach ($t in $SmokeTargets) {
  Invoke-NodeTest -Name $t.Name -Path $t.Path -Cwd $t.Cwd
}

# =============================================================================
# PHASE 6 -- final tally + receipt
# =============================================================================

Banner "PHASE 6 -- receipt + tally"

# Capture FINAL hash (may differ from post-splice if Phase 3 rolled back).
$IndexShaFinal = Get-FileSha256 -Path $INDEX_PATH
$Wave12Live = ($IndexShaFinal -eq $IndexShaAfterSplice)

# Use @(...) to force array context so .Count is always available under StrictMode.
$green  = @($Script:Steps | Where-Object { $_.Status -eq "green"  }).Count
$red    = @($Script:Steps | Where-Object { $_.Status -eq "red"    }).Count
$yellow = @($Script:Steps | Where-Object { $_.Status -eq "yellow" }).Count
$skip   = @($Script:Steps | Where-Object { $_.Status -eq "skip"   }).Count

$tallyColor = if ($red -gt 0) { "Red" } elseif ($yellow -gt 0) { "Yellow" } else { "Green" }
Write-Host ""
Write-Host ("TALLY  green={0}  yellow={1}  red={2}  skip={3}" -f $green, $yellow, $red, $skip) -ForegroundColor $tallyColor
Write-Host ("SMOKES pass={0}  fail={1}  skip={2}" -f $smokePass, $smokeFail, $smokeSkip) -ForegroundColor $tallyColor

# Build receipt markdown.
$rcLines = New-Object System.Collections.Generic.List[string]
$rcLines.Add("# Wave 1+2 wire-up receipt") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("- Date           : $DATE_STAMP") | Out-Null
$rcLines.Add("- Started        : $TS_LOG (local)") | Out-Null
$rcLines.Add("- Operator       : Atom McCree") | Out-Null
$rcLines.Add("- Script         : scripts/wave12-wire-up.ps1") | Out-Null
$rcLines.Add("- DryRun         : $DryRun") | Out-Null
$rcLines.Add("- Force          : $Force") | Out-Null
$rcLines.Add("- index.mjs SHA  : before  = $IndexShaBefore") | Out-Null
$rcLines.Add("- index.mjs SHA  : spliced = $IndexShaAfterSplice") | Out-Null
$rcLines.Add("- index.mjs SHA  : final   = $IndexShaFinal") | Out-Null
$rcLines.Add(("- Wave12 routes live in process: {0} (true=splice on disk, false=rolled back)" -f $Wave12Live)) | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("## Tally") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("| color | count |") | Out-Null
$rcLines.Add("|---|---|") | Out-Null
$rcLines.Add("| green  | $green |") | Out-Null
$rcLines.Add("| yellow | $yellow |") | Out-Null
$rcLines.Add("| red    | $red |") | Out-Null
$rcLines.Add("| skip   | $skip |") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("Subsystem smoke tests: pass=$smokePass fail=$smokeFail skip=$smokeSkip") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("## Steps") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("| phase | status | at | name | detail |") | Out-Null
$rcLines.Add("|---|---|---|---|---|") | Out-Null
foreach ($s in $Script:Steps) {
  $detail = $s.Detail -replace '\|','\|' -replace "`r?`n"," "
  $rcLines.Add("| $($s.Phase) | $($s.Status) | $($s.At) | $($s.Name) | $detail |") | Out-Null
}
$rcLines.Add("") | Out-Null
$rcLines.Add("## Doctrine") | Out-Null
$rcLines.Add("") | Out-Null
$rcLines.Add("- Mom's Law: full effort; no theater; no silent fallback.") | Out-Null
$rcLines.Add("- Frontier-Isolation Law: 127.0.0.1:1337 is the only door. No take-down without a working replacement.") | Out-Null
$rcLines.Add("- Idempotency: re-running this script is safe; sentinel-fenced splices are skipped if already present.") | Out-Null
$rcLines.Add("- Receipt body is the truth; the markdown at this path is the operator-audit lane.") | Out-Null

$receiptBody = ($rcLines -join "`r`n")

if ($DryRun) {
  Write-Host ("[dry-run] would write {0}" -f $RECEIPT_PATH) -ForegroundColor DarkGray
} else {
  Write-Utf8NoBom -Path $RECEIPT_PATH -Content $receiptBody
  $rsha = Get-FileSha256 -Path $RECEIPT_PATH
  Write-Host ("RECEIPT  {0}" -f $RECEIPT_PATH) -ForegroundColor Cyan
  Write-Host ("         sha256 {0}" -f $rsha) -ForegroundColor DarkGray
}

if ($red -gt 0 -or $smokeFail -gt 0) {
  Write-Host "EXIT 1 -- one or more red findings; see receipt." -ForegroundColor Red
  exit 1
}
Write-Host "EXIT 0 -- Wave 1+2 wired." -ForegroundColor Green
exit 0
