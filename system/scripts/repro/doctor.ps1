# doctor.ps1
# Orange5 sovereign-reproducibility diagnostic.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law -- full effort, no theater, no silent fallback, no fake
#   green. Every endpoint gets a real HTTP probe. Every response is judged on
#   its byte content, not on "the process is running." A daemon that answers
#   /healthz with HTTP 200 is GREEN. A daemon that times out, refuses TCP, or
#   answers 5xx is RED. No middle ground except YELLOW for "optional dep not
#   wired" (smart-skinny upstream, cobra flux, ollama).
#
# Mission: the kubectl-get-pods of Orange5. The script the operator runs when
#   "something is broken, what?" -- and gets back a single page that tells the
#   honest truth about which subsystem is alive and which is dead, with the
#   evidence inline.
#
# Position in the repro lane:
#     bootstrap.ps1   -> toolchain on the metal
#     install.ps1     -> unzip, wire, boot daemons
#     verify.ps1      -> RUN every test + battery + chain-verify
#     timing.ps1      -> wrap the whole 30-min SLA receipt
#     doctor.ps1  *   -> THIS: read-only probe of every live endpoint, fast
#                        triage when something stops being green
#
#   doctor.ps1 is the cheapest, fastest of the five. It exists for the moment
#   an operator says "the cockpit looks weird, is it me or is it broken?" --
#   one command, ~20 seconds, a real diagnosis.
#
# What this probes (every Orange5 endpoint that exists in the live tree):
#
#   Required (RED if missing):
#     - Gateway :1337     /healthz, /v1/models, /v1/toolmesh/labs,
#                         /v1/toolmesh/search, /guardrails-27/healthz
#                         (orchestrator front door; the only legal door from
#                         frontier to Orange5)
#     - Hermes :7430      /healthz, /approvals
#                         (lease engine + approvals surface)
#     - Nine-Gate :7450   /healthz
#                         (gates 0-8 pipeline; LBCE is gate 0)
#     - Guardrails-27 :7460
#                         /healthz, /latest, /soul-genome, /continuity
#                         (the 27 constitutional guardrails daemon)
#
#   Optional (YELLOW if missing, NEVER RED -- these are off by default on a
#   bare bootstrap, and turning them on is its own lane):
#     - Smart-Skinny upstream :8797   /healthz, /v1/models
#                                     (PR-03 upstream the gateway proxies to)
#     - AE Cobra flux loopback :7419  /healthz
#                                     (Reality Flux daemon -- visual-event
#                                     writer; spool flushes here)
#     - Ollama loopback :11434        /api/tags
#                                     (local model lane; bootstrap installs
#                                     the CLI but the operator launches the
#                                     tray app once)
#
# What this does NOT do (Mom's Law: one job per script):
#   - Install anything                 -> bootstrap.ps1
#   - Boot any daemons                 -> install.ps1
#   - Run the test suite               -> verify.ps1
#   - Wrap the 30-min SLA              -> timing.ps1
#   - Touch the SkilSki live app       -> never, anywhere, ever
#   - Mutate any state                 -> doctor is read-only by contract
#
# Idempotency: this script is read-only against the live tree AND the live
#   daemons. It writes exactly one artifact: a markdown receipt at
#   10-RECEIPTS/orange5-doctor/<ts>-doctor.md. Re-running just produces a
#   new dated receipt. No mutation of code, db, daemon state, or environment.
#
# Flags:
#   -TimeoutSec N      Per-probe HTTP timeout. Default: 4 seconds. A daemon
#                      that needs longer than 4s to answer /healthz is not
#                      green by Mom's Law standards.
#   -SkipOptional      Don't probe smart-skinny, cobra, ollama. Useful in CI
#                      lanes where only the four required daemons matter.
#   -Json              Print a final one-line JSON tally to stdout (for CI
#                      and external dashboards).
#   -Quiet             Suppress the per-probe console log; only the final
#                      tally + receipt path are written to console. Receipt
#                      is still written fully. Mom does not care if you saw
#                      it scroll by, she cares that the receipt is honest.
#   -ReceiptDir <p>    Override receipt output directory.
#   -NoReceipt         Don't write a receipt file. Console only. For ad-hoc
#                      interactive checks; the receipt is the operator's
#                      friend, so this is opt-out, not opt-in.
#
# Exit codes (honest):
#   0  Every required endpoint answered HTTP 200. Optional endpoints either
#      answered 200 or were correctly absent (YELLOW). Diagnosis: GREEN.
#   1  At least one required endpoint did not answer 200. Diagnosis: RED.
#      Receipt is still written -- it is the post-mortem.
#   2  Fatal pre-flight (cannot write receipt dir AND -NoReceipt not set).
#
# Reference receipts to read after a RED run:
#   10-RECEIPTS/orange5-doctor/<ts>-doctor.md   (this script)
#   10-RECEIPTS/orange5-bootstrap/<ts>-install.md (last install)
#   10-RECEIPTS/orange5-verify/<ts>-verify.md   (last verify)

[CmdletBinding()]
param(
  [int]$TimeoutSec = 4,
  [switch]$SkipOptional,
  [switch]$Json,
  [switch]$Quiet,
  [string]$ReceiptDir,
  [switch]$NoReceipt
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

$SCRIPT_DIR   = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$ORANGE5_ROOT = Split-Path -Parent (Split-Path -Parent $SCRIPT_DIR)   # C:\AtomEons\Orange5

if (-not $ReceiptDir -or [string]::IsNullOrWhiteSpace($ReceiptDir)) {
  $ReceiptDir = Join-Path $ORANGE5_ROOT "10-RECEIPTS\orange5-doctor"
}
$RUN_STAMP    = Get-Date -Format "yyyy-MM-dd_HH-mm-ss"
$RECEIPT_PATH = Join-Path $ReceiptDir ("{0}-doctor.md" -f $RUN_STAMP)

# ---------------------------------------------------------------------------
# Endpoint catalog
# ---------------------------------------------------------------------------
# Each entry: Subsystem, Name (route), URL, Method, Required, ExpectStatus,
# ExpectBodyMatch (optional regex on response body -- adds proof beyond the
# status code), Notes (operator-facing diagnostic if RED).
#
# This catalog is the SINGLE SOURCE OF TRUTH for what doctor.ps1 checks.
# When a new route ships in the gateway / daemons, append it here -- the
# rest of the script is generic. Mom's Law: don't fork the catalog into
# code paths; one table, one truth.

$ENDPOINTS = @(
  # ----- Gateway :1337 (the orchestrator front door) -----
  @{ Subsystem="gateway"; Name="GET /healthz";              Url="http://127.0.0.1:1337/healthz";              Method="GET";  Required=$true;  ExpectStatus=200; ExpectBodyMatch='"ok"\s*:\s*true|orangellm|version'; Notes="If RED: gateway dead. Check: install.ps1 phase 4 wave12-wire-up; orange5-bootstrap/*-install.md." }
  @{ Subsystem="gateway"; Name="GET /v1/models";            Url="http://127.0.0.1:1337/v1/models";            Method="GET";  Required=$true;  ExpectStatus=200; ExpectBodyMatch='orange-auto|orange-navigator'; Notes="If RED: Navigator Kernel or Codexa model discovery is broken." }
  @{ Subsystem="gateway"; Name="GET /v1/toolmesh/labs";     Url="http://127.0.0.1:1337/v1/toolmesh/labs";     Method="GET";  Required=$true;  ExpectStatus=200; ExpectBodyMatch='labs|cards|\[\]'; Notes="If RED: toolmesh registry not loaded. Check 13-TOOLMESH registry files." }
  @{ Subsystem="gateway"; Name="GET /v1/toolmesh/search";   Url="http://127.0.0.1:1337/v1/toolmesh/search?q=";Method="GET";  Required=$true;  ExpectStatus=200; ExpectBodyMatch='results|hits|\[\]'; Notes="If RED: toolmesh search index missing." }

  # ----- Hermes :7430 (lease + approvals) -----
  @{ Subsystem="hermes"; Name="GET /healthz";   Url="http://127.0.0.1:7430/healthz";   Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='"ok"\s*:\s*true|hermes'; Notes="If RED: hermes dead. Check: 08-HERMES bun process; orange5-bootstrap/*-install.md phase 5." }
  @{ Subsystem="hermes"; Name="GET /approvals"; Url="http://127.0.0.1:7430/approvals"; Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='approvals|leases|\[\]'; Notes="If RED: approvals surface broken. Check 08-HERMES/src/server.mjs." }

  # ----- Nine-Gate :7450 (gates 0-8 pipeline) -----
  @{ Subsystem="nine-gate-stack"; Name="GET /healthz"; Url="http://127.0.0.1:7450/healthz"; Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='"ok"\s*:\s*true|gate|nine'; Notes="If RED: 9-Gate stack down. Gate 0 is LBCE; without it, no promotion is legal. Restart: bun run server.mjs in 04-CONTROL-PLANE/nine-gate-stack/." }

  # ----- Guardrails-27 :7460 (the 27 constitutional guardrails) -----
  @{ Subsystem="guardrails-27"; Name="GET /healthz";     Url="http://127.0.0.1:7460/healthz";     Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='"ok"\s*:\s*true|guardrails|last_run'; Notes="If RED: guardrails daemon dead. Restart: node launch.mjs start in 01-DOCTRINE/27-guardrails/." }
  @{ Subsystem="guardrails-27"; Name="GET /latest";      Url="http://127.0.0.1:7460/latest";      Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='guardrails|run_id|results|null|\{'; Notes="If RED: guardrails has no run history. Trigger one: GET /run." }
  @{ Subsystem="guardrails-27"; Name="GET /soul-genome"; Url="http://127.0.0.1:7460/soul-genome"; Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='soul|genome|\{'; Notes="If RED: Soul Genome read surface broken. Check 01-DOCTRINE/27-guardrails/state/." }
  @{ Subsystem="guardrails-27"; Name="GET /continuity";  Url="http://127.0.0.1:7460/continuity";  Method="GET"; Required=$true; ExpectStatus=200; ExpectBodyMatch='continuity|packet|\{'; Notes="If RED: Continuity Packet read surface broken." }

  # ----- Optional: AE Cobra flux :7419 (Reality Flux) -----
  @{ Subsystem="ae-cobra"; Name="GET /healthz"; Url="http://127.0.0.1:7419/healthz"; Method="GET"; Required=$false; ExpectStatus=200; ExpectBodyMatch='ok|cobra|flux'; Notes="YELLOW expected on bootstrap. Cobra is the visual-event flux writer; spool at 01-DOCTRINE/27-guardrails/state/flux-spool.jsonl replays when reachable." }

  # ----- Optional: Ollama loopback :11434 (local model lane) -----
  @{ Subsystem="ollama"; Name="GET /api/tags"; Url="http://127.0.0.1:11434/api/tags"; Method="GET"; Required=$false; ExpectStatus=200; ExpectBodyMatch='models|\[\]|\{'; Notes="YELLOW expected on bootstrap. bootstrap.ps1 installs the ollama CLI; the operator must launch the tray app once to bring up :11434." }
)

# ---------------------------------------------------------------------------
# State + logging
# ---------------------------------------------------------------------------

$RUN_START = Get-Date
$RESULTS   = New-Object System.Collections.ArrayList
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
    default  { "Gray" }
  }
  Write-Host $line -ForegroundColor $color
}

function Banner {
  param([string]$Text)
  [void]$LOG_LINES.Add("")
  [void]$LOG_LINES.Add(("=== {0} ===" -f $Text))
  if ($Quiet) { return }
  Write-Host ""
  Write-Host ("=== {0} ===" -f $Text) -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# The probe -- single HTTP call, real timeout, real exit reasons
# ---------------------------------------------------------------------------
# We use Invoke-WebRequest with -UseBasicParsing to avoid the IE engine that
# trips up on headless boxes. We catch every exception class we have actually
# observed in this tree:
#   - ConnectionRefused (daemon not listening)              -> "tcp refused"
#   - HostNotFound (unlikely on loopback, but possible)     -> "no host"
#   - Timeout (daemon hung)                                 -> "timeout"
#   - 4xx/5xx (daemon up but route broken)                  -> "http <code>"
#   - SSL/cert errors (someone added https)                 -> "ssl"
#   - Anything else                                         -> exception class
#
# The probe returns a hashtable with enough fields to render a tight diagnostic
# row in both console and markdown. We do NOT swallow the exception silently;
# the message is captured so the receipt can show it.

function Invoke-Probe {
  param(
    [Parameter(Mandatory)][string]$Url,
    [string]$Method = "GET",
    [int]$TimeoutSec = 4
  )
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ok          = $false
  $statusCode  = 0
  $body        = ""
  $bodyBytes   = 0
  $errClass    = ""
  $errMsg      = ""
  try {
    # -UseBasicParsing is required on stock Windows PowerShell 5.1 (no IE in
    # some images). On pwsh 7+ it is a no-op.
    $resp = Invoke-WebRequest -Uri $Url -Method $Method -UseBasicParsing `
            -TimeoutSec $TimeoutSec -ErrorAction Stop
    $statusCode = [int]$resp.StatusCode
    $body       = ($resp.Content | Out-String)
    $bodyBytes  = if ($body) { [Text.Encoding]::UTF8.GetByteCount($body) } else { 0 }
    if ($statusCode -ge 200 -and $statusCode -lt 300) { $ok = $true }
  } catch {
    # Single catch block -- typed catches for System.Net.Http.* are unsafe
    # on stock Windows PowerShell 5.1 (the type may not be loaded in this
    # AppDomain). We classify by runtime type name instead.
    $ex      = $_.Exception
    $exType  = $ex.GetType().FullName
    $errMsg  = $ex.Message
    switch -Regex ($exType) {
      'System\.Net\.WebException' {
        $errClass = "WebException"
        if ($ex.Response) {
          try { $statusCode = [int]$ex.Response.StatusCode } catch {}
        } elseif ($ex.Status) {
          $errClass = "$($ex.Status)"
        }
        break
      }
      'System\.Net\.Http\.HttpRequestException' {
        $errClass = "HttpRequestException"
        # .StatusCode exists on pwsh 7+ only; guard.
        if ($ex.PSObject.Properties.Name -contains 'StatusCode' -and $ex.StatusCode) {
          try { $statusCode = [int]$ex.StatusCode } catch {}
        }
        break
      }
      'OperationCanceledException|TaskCanceledException' {
        $errClass = "Timeout"
        $errMsg   = "request exceeded ${TimeoutSec}s"
        break
      }
      default {
        $errClass = $ex.GetType().Name
      }
    }
  }
  $sw.Stop()
  $ms = [Math]::Round($sw.Elapsed.TotalMilliseconds, 1)
  return @{
    Ok         = $ok
    StatusCode = $statusCode
    Body       = $body
    BodyBytes  = $bodyBytes
    LatencyMs  = $ms
    ErrClass   = $errClass
    ErrMsg     = $errMsg
  }
}

# ---------------------------------------------------------------------------
# Probe runner -- maps catalog rows to result rows
# ---------------------------------------------------------------------------

function Probe-Endpoint {
  param([hashtable]$E)

  # Required vs optional decides RED vs YELLOW on failure. Mom's Law: missing
  # optional bits are honest absence, not fake red. Missing required bits ARE
  # the diagnosis.
  $required = [bool]$E.Required
  $r = Invoke-Probe -Url $E.Url -Method $E.Method -TimeoutSec $TimeoutSec

  $status = ""
  $bodyMatch = $null
  if ($r.Ok -and $r.StatusCode -eq $E.ExpectStatus) {
    # Body shape sanity-check. If the catalog declares an ExpectBodyMatch,
    # we require it -- a 200 with the wrong body is theater.
    if ($E.ExpectBodyMatch) {
      try {
        $bodyMatch = [bool]([regex]::IsMatch($r.Body, $E.ExpectBodyMatch))
      } catch {
        $bodyMatch = $false
      }
      if ($bodyMatch) {
        $status = "GREEN"
      } else {
        $status = if ($required) { "RED" } else { "YELLOW" }
      }
    } else {
      $status = "GREEN"
    }
  } else {
    $status = if ($required) { "RED" } else { "YELLOW" }
  }

  $diagnosis = ""
  if ($status -ne "GREEN") {
    if ($r.ErrClass -or $r.ErrMsg) {
      $diagnosis = "$($r.ErrClass): $($r.ErrMsg)"
    } elseif ($r.StatusCode -ne 0 -and $r.StatusCode -ne $E.ExpectStatus) {
      $diagnosis = "HTTP $($r.StatusCode) (expected $($E.ExpectStatus))"
    } elseif ($bodyMatch -eq $false) {
      $diagnosis = "body did not match expected pattern: $($E.ExpectBodyMatch)"
    } else {
      $diagnosis = "unknown failure"
    }
  }

  $bodyPreview = ""
  if ($r.Body) {
    $t = $r.Body.Trim()
    if ($t.Length -gt 160) { $bodyPreview = $t.Substring(0,160) + "..." } else { $bodyPreview = $t }
    # Markdown table cells cannot survive pipe / newline.
    $bodyPreview = ($bodyPreview -replace '\|','/' -replace '[\r\n]+',' ')
  }

  $row = [pscustomobject]@{
    Subsystem    = $E.Subsystem
    Name         = $E.Name
    Url          = $E.Url
    Required     = $required
    Status       = $status
    HttpCode     = $r.StatusCode
    LatencyMs    = $r.LatencyMs
    BodyBytes    = $r.BodyBytes
    BodyMatch    = $bodyMatch
    BodyPreview  = $bodyPreview
    Diagnosis    = $diagnosis
    Notes        = $E.Notes
  }
  [void]$RESULTS.Add($row)

  $color = switch ($status) { "GREEN" {"GREEN"} "YELLOW" {"YELLOW"} default {"RED"} }
  $reqMark = if ($required) { "REQ" } else { "OPT" }
  $logMsg = "{0,-16} {1,-3} {2,-32} {3,-6} {4,5}ms" -f `
    $E.Subsystem, $reqMark, $E.Name, $r.StatusCode, $r.LatencyMs
  if ($status -ne "GREEN") { $logMsg += "  :: $diagnosis" }
  Log $color $logMsg
}

# ---------------------------------------------------------------------------
# Pre-flight (cheap -- we are read-only)
# ---------------------------------------------------------------------------

Banner ("Orange5 doctor -- diagnostic probe (timeout {0}s/probe, optional={1})" -f $TimeoutSec, (-not $SkipOptional))
Log "INFO" ("script dir : {0}" -f $SCRIPT_DIR)
Log "INFO" ("repo root  : {0}" -f $ORANGE5_ROOT)
if (-not $NoReceipt) { Log "INFO" ("receipt    : {0}" -f $RECEIPT_PATH) }

if (-not $NoReceipt) {
  try {
    if (-not (Test-Path $ReceiptDir)) {
      [void](New-Item -ItemType Directory -Path $ReceiptDir -Force)
    }
  } catch {
    Log "RED" ("cannot create receipt dir: {0}" -f $_.Exception.Message)
    exit 2
  }
}

# ---------------------------------------------------------------------------
# Probe sweep
# ---------------------------------------------------------------------------

Banner "Endpoint sweep"
$probed = 0
foreach ($e in $ENDPOINTS) {
  if ($SkipOptional -and -not [bool]$e.Required) {
    Log "INFO" ("SKIP (optional) {0} {1}" -f $e.Subsystem, $e.Name)
    continue
  }
  Probe-Endpoint -E $e
  $probed++
}

# ---------------------------------------------------------------------------
# Subsystem rollup
# ---------------------------------------------------------------------------
# A subsystem is GREEN iff every REQUIRED row in it is GREEN. Optional rows
# can be YELLOW without dragging the subsystem to RED. This matches how the
# rest of the repro lane reasons.

$subsystemRollup = New-Object System.Collections.ArrayList
$subs = @($RESULTS | Select-Object -ExpandProperty Subsystem -Unique)
foreach ($s in $subs) {
  $rows = @($RESULTS | Where-Object { $_.Subsystem -eq $s })
  $reqRows = @($rows | Where-Object { $_.Required })
  $optRows = @($rows | Where-Object { -not $_.Required })

  $reqGreen = @($reqRows | Where-Object { $_.Status -eq "GREEN" }).Count
  $reqRed   = @($reqRows | Where-Object { $_.Status -eq "RED"   }).Count
  $optGreen = @($optRows | Where-Object { $_.Status -eq "GREEN" }).Count
  $optYel   = @($optRows | Where-Object { $_.Status -eq "YELLOW" }).Count

  $status = if ($reqRows.Count -eq 0) {
              # Pure-optional subsystem (smart-skinny, cobra, ollama).
              if ($optGreen -gt 0) { "GREEN" } else { "YELLOW" }
            } elseif ($reqRed -gt 0) {
              "RED"
            } elseif ($optYel -gt 0) {
              "GREEN-OPT-YELLOW"   # required all green, but optional missing.
            } else {
              "GREEN"
            }

  [void]$subsystemRollup.Add([pscustomobject]@{
    Subsystem  = $s
    Status     = $status
    ReqTotal   = $reqRows.Count
    ReqGreen   = $reqGreen
    ReqRed     = $reqRed
    OptTotal   = $optRows.Count
    OptGreen   = $optGreen
    OptYellow  = $optYel
  })
}

# ---------------------------------------------------------------------------
# Final tally
# ---------------------------------------------------------------------------

$totalGreen  = @($RESULTS | Where-Object { $_.Status -eq "GREEN"  }).Count
$totalRed    = @($RESULTS | Where-Object { $_.Status -eq "RED"    }).Count
$totalYellow = @($RESULTS | Where-Object { $_.Status -eq "YELLOW" }).Count

# "Healthy?" means: every REQUIRED endpoint is GREEN. Optional YELLOW is OK.
$healthy = ($totalRed -eq 0)

$RUN_END  = Get-Date
$TotalSec = [Math]::Round(($RUN_END - $RUN_START).TotalSeconds, 2)

Banner "FINAL DIAGNOSIS"
$verdict = if ($healthy) { "GREEN" } else { "RED" }
$color = if ($healthy) { "Green" } else { "Red" }
if (-not $Quiet) {
  Write-Host ("probed={0}  green={1}  yellow={2}  red={3}  in {4}s" -f $probed, $totalGreen, $totalYellow, $totalRed, $TotalSec) -ForegroundColor $color
  Write-Host ("verdict: {0}" -f $verdict) -ForegroundColor $color
}

# ---------------------------------------------------------------------------
# Receipt
# ---------------------------------------------------------------------------

if (-not $NoReceipt) {
  $rc = New-Object System.Collections.ArrayList
  [void]$rc.Add("# Orange5 doctor receipt -- $RUN_STAMP")
  [void]$rc.Add("")
  [void]$rc.Add("- doctrine: Mom's Law -- full effort; no theater; no silent fallback.")
  [void]$rc.Add("- script:   scripts/repro/doctor.ps1")
  [void]$rc.Add("- repo:     $ORANGE5_ROOT")
  [void]$rc.Add("- host:     $env:COMPUTERNAME (user: $env:USERNAME)")
  [void]$rc.Add("- pwsh:     $($PSVersionTable.PSVersion.ToString())")
  [void]$rc.Add("- start:    $($RUN_START.ToString('o'))")
  [void]$rc.Add("- end:      $($RUN_END.ToString('o'))")
  [void]$rc.Add("- elapsed:  ${TotalSec}s")
  [void]$rc.Add("- timeout per probe: ${TimeoutSec}s")
  [void]$rc.Add("- skip-optional: $SkipOptional")
  [void]$rc.Add("- verdict:  $verdict")
  [void]$rc.Add("")

  [void]$rc.Add("## Subsystem rollup")
  [void]$rc.Add("")
  [void]$rc.Add("| subsystem | status | required (green/total) | optional (green/yellow/total) |")
  [void]$rc.Add("|-----------|--------|------------------------|-------------------------------|")
  foreach ($s in $subsystemRollup) {
    [void]$rc.Add(("| {0} | {1} | {2}/{3} | {4}/{5}/{6} |" -f `
      $s.Subsystem, $s.Status, $s.ReqGreen, $s.ReqTotal, $s.OptGreen, $s.OptYellow, $s.OptTotal))
  }
  [void]$rc.Add("")

  [void]$rc.Add("## Tally")
  [void]$rc.Add("")
  [void]$rc.Add("| pill | count |")
  [void]$rc.Add("|------|-------|")
  [void]$rc.Add("| GREEN  | $totalGreen |")
  [void]$rc.Add("| YELLOW | $totalYellow |")
  [void]$rc.Add("| RED    | $totalRed |")
  [void]$rc.Add("")

  [void]$rc.Add("## Per-endpoint probes")
  [void]$rc.Add("")
  [void]$rc.Add("| subsystem | route | required | status | http | latency_ms | body_bytes | diagnosis |")
  [void]$rc.Add("|-----------|-------|---------:|--------|-----:|-----------:|-----------:|-----------|")
  foreach ($r in $RESULTS) {
    $reqStr = if ($r.Required) { "yes" } else { "no" }
    $diag = ($r.Diagnosis -replace '\|','/' -replace '[\r\n]+',' ')
    [void]$rc.Add(("| {0} | {1} | {2} | {3} | {4} | {5} | {6} | {7} |" -f `
      $r.Subsystem, $r.Name, $reqStr, $r.Status, $r.HttpCode, $r.LatencyMs, $r.BodyBytes, $diag))
  }
  [void]$rc.Add("")

  # Body previews -- inline so the operator does not have to re-curl.
  [void]$rc.Add("## Body previews (first 160 bytes)")
  [void]$rc.Add("")
  foreach ($r in $RESULTS) {
    if ([string]::IsNullOrWhiteSpace($r.BodyPreview)) { continue }
    [void]$rc.Add("### $($r.Subsystem) -- $($r.Name) ($($r.Status))")
    [void]$rc.Add("")
    [void]$rc.Add('```')
    [void]$rc.Add($r.BodyPreview)
    [void]$rc.Add('```')
    [void]$rc.Add("")
  }

  # RED diagnosis with operator-facing notes -- the whole point of this script.
  $reds = @($RESULTS | Where-Object { $_.Status -eq "RED" })
  if ($reds.Count -gt 0) {
    [void]$rc.Add("## RED endpoints -- triage")
    [void]$rc.Add("")
    foreach ($r in $reds) {
      [void]$rc.Add("### $($r.Subsystem) -- $($r.Name)")
      [void]$rc.Add("")
      [void]$rc.Add("- URL:        $($r.Url)")
      [void]$rc.Add("- HTTP:       $($r.HttpCode)")
      [void]$rc.Add("- latency:    $($r.LatencyMs) ms")
      [void]$rc.Add("- diagnosis:  $($r.Diagnosis)")
      [void]$rc.Add("- operator action: $($r.Notes)")
      [void]$rc.Add("")
    }
  }
  $yels = @($RESULTS | Where-Object { $_.Status -eq "YELLOW" })
  if ($yels.Count -gt 0) {
    [void]$rc.Add("## YELLOW endpoints -- optional, honest absence")
    [void]$rc.Add("")
    [void]$rc.Add("These are optional dependencies that are not currently reachable. They are NOT counted against the verdict -- a fresh-bootstrap box is expected to have these YELLOW until the operator wires them up.")
    [void]$rc.Add("")
    foreach ($r in $yels) {
      [void]$rc.Add("- $($r.Subsystem) $($r.Name) -- $($r.Diagnosis) :: $($r.Notes)")
    }
    [void]$rc.Add("")
  }

  [void]$rc.Add("## Log")
  [void]$rc.Add("")
  [void]$rc.Add('```')
  foreach ($l in $LOG_LINES) { [void]$rc.Add($l) }
  [void]$rc.Add('```')
  [void]$rc.Add("")

  [void]$rc.Add("## Doctrine")
  [void]$rc.Add("")
  [void]$rc.Add("- doctor.ps1 is read-only by contract. It mutates no daemon state, no config, no file outside this receipt.")
  [void]$rc.Add("- A daemon is GREEN iff its /healthz returns HTTP 200 AND the body matches the expected shape. 'Process is alive' is not green.")
  [void]$rc.Add("- A subsystem is GREEN iff every REQUIRED endpoint in it is GREEN. Optional misses are YELLOW, never RED.")
  [void]$rc.Add("- Verdict is GREEN iff zero RED rows. YELLOW does not block.")
  [void]$rc.Add("- Sibling scripts: bootstrap.ps1 (toolchain), install.ps1 (extract+boot), verify.ps1 (battery), timing.ps1 (30-min SLA). doctor.ps1 is the diagnostic, NOT the installer.")

  # Write receipt UTF-8 no BOM (match the wave12 / verify / install convention).
  try {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($RECEIPT_PATH, (($rc -join "`r`n")), $enc)
    $rsha = (Get-FileHash -LiteralPath $RECEIPT_PATH -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $Quiet) {
      Write-Host ("receipt: {0}" -f $RECEIPT_PATH) -ForegroundColor DarkCyan
      Write-Host ("sha256:  {0}" -f $rsha) -ForegroundColor DarkCyan
    }
  } catch {
    Log "RED" ("could not write receipt: {0}" -f $_.Exception.Message)
  }
}

# ---------------------------------------------------------------------------
# Optional JSON tally for CI / external dashboards
# ---------------------------------------------------------------------------

if ($Json) {
  $jsonOut = @{
    ok          = $healthy
    verdict     = $verdict
    probed      = $probed
    elapsed_sec = $TotalSec
    timeout_sec = $TimeoutSec
    tally       = @{ green=$totalGreen; yellow=$totalYellow; red=$totalRed }
    subsystems  = @($subsystemRollup | ForEach-Object {
                    @{ name=$_.Subsystem; status=$_.Status;
                       req_green=$_.ReqGreen; req_total=$_.ReqTotal;
                       opt_green=$_.OptGreen; opt_yellow=$_.OptYellow; opt_total=$_.OptTotal } })
    endpoints   = @($RESULTS | ForEach-Object {
                    @{ subsystem=$_.Subsystem; name=$_.Name; url=$_.Url;
                       required=$_.Required; status=$_.Status; http=$_.HttpCode;
                       latency_ms=$_.LatencyMs; diagnosis=$_.Diagnosis } })
    receipt     = if ($NoReceipt) { $null } else { $RECEIPT_PATH }
  } | ConvertTo-Json -Depth 6 -Compress
  Write-Host $jsonOut
}

# ---------------------------------------------------------------------------
# Exit code (honest)
# ---------------------------------------------------------------------------
# 0 -- every REQUIRED endpoint GREEN. Verdict GREEN.
# 1 -- at least one REQUIRED endpoint not GREEN. Verdict RED.
# 2 -- fatal pre-flight (handled earlier with explicit exit 2).

if ($healthy) { exit 0 } else { exit 1 }
