# preflight.ps1
# Codexa migration pre-flight verifier.
#
# Owner: Atom McCree (Sovereign).
# Doctrine: Mom's Law + No-Take-Down Law. We never kill a legacy Codexa
#   container until its replacement is proven LIVE, its data is proven backed
#   up, and the operator has explicitly authorized the cut. This script does
#   not kill anything. It is a gate. It refuses to return green unless every
#   precondition is real.
#
# Per Receipt #013 (Codexa migration plan):
#   - W1 close kills: aeorangebox-ai-box-open-webui-1, aeorangebox-ai-box-n8n-1
#   - W2 close kill : aeorangebox-ai-box-wiki-1
#   - KEEP          : aeorangebox-ai-box-qdrant-1
#   - EVALUATE      : aeorangebox-ai-box-postgres-1, aeorangebox-ai-box-redis-1
#
# Replacements that must be green before any kill:
#   - Atomic Orange installer  --> replaces open-webui
#   - Hermes daemon            --> replaces n8n
#   - Vault lane + Mirage      --> replaces orangebox-wiki (StateBrief surface)
#
# Phases (gates):
#   1. Docker reachable + legacy containers enumerable.
#   2. Replacement #1: Atomic Orange installer is green.
#   3. Replacement #2: Hermes daemon is LIVE.
#   4. Replacement #3: Vault lane LIVE w/ Mirage StateBrief.
#   5. Qdrant data backed up (snapshot exists, recent, non-empty).
#   6. Postgres volume snapshot present + recent.
#   7. Redis volume snapshot present + recent.
#   8. Authorization gate: -AuthorizeKill flag was passed AND wave window
#      (-Wave W1|W2) names a legal kill set per Receipt #013.
#
# This script REFUSES to proceed (exit 1) on any RED. On all-green it writes a
# JSON receipt the kill scripts read; without that receipt the killers refuse
# to run.
#
# Flags:
#   -Wave W1|W2        : which wave-close cut is being staged. Required for the
#                        authorization gate to evaluate the right kill set.
#   -AuthorizeKill     : operator confirms intent to cut. Without this, even an
#                        all-green run emits a yellow "DRY" receipt that the
#                        killers will reject.
#   -BackupRoot <path> : where snapshots live. Defaults to
#                        C:\AtomEons\backups\codexa-migration\.
#   -MaxSnapshotAgeHrs : a backup older than this is treated as stale (RED).
#                        Default 24.
#   -DryRun            : print every check, mutate nothing, do not write the
#                        receipt. Exits 0 if all gates would pass, 1 otherwise.
#   -Verbose           : extra log lines per gate.
#
# Exit codes:
#   0  all gates green AND -AuthorizeKill present: kill receipt written.
#   1  one or more gates red, OR green-but-not-authorized: receipt is yellow
#      "DRY" or absent. Killers will refuse.
#   2  fatal pre-flight (Docker daemon unreachable, backup root unwritable,
#      etc.) -- no gate evaluation possible.

[CmdletBinding()]
param(
  [ValidateSet("W1","W2")]
  [string]$Wave,
  [switch]$AuthorizeKill,
  [string]$BackupRoot = "C:\AtomEons\backups\codexa-migration",
  [int]$MaxSnapshotAgeHrs = 24,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths (anchored, never relative) ---------------------------------------
$ORANGE5_ROOT        = "C:\AtomEons\Orange5"
$RECEIPT_DIR         = Join-Path $ORANGE5_ROOT "receipts\codexa-migration"
$RECEIPT_PATH        = Join-Path $RECEIPT_DIR "preflight.json"
$ATOMIC_ORANGE_PROBE = "http://127.0.0.1:1337/healthz"
$HERMES_PROBE        = "http://127.0.0.1:8730/healthz"
$VAULT_PROBE         = "http://127.0.0.1:8740/vault/healthz"
$MIRAGE_PROBE        = "http://127.0.0.1:8740/vault/state-brief"

# --- Legacy container names (per Receipt #013) ------------------------------
$LEGACY = @{
  "open-webui" = "aeorangebox-ai-box-open-webui-1"
  "n8n"        = "aeorangebox-ai-box-n8n-1"
  "wiki"       = "aeorangebox-ai-box-wiki-1"
  "qdrant"     = "aeorangebox-ai-box-qdrant-1"
  "postgres"   = "aeorangebox-ai-box-postgres-1"
  "redis"      = "aeorangebox-ai-box-redis-1"
}

# --- Kill set by wave (per Receipt #013) ------------------------------------
$KILL_SET = @{
  "W1" = @("open-webui","n8n")
  "W2" = @("wiki")
}

# --- Gate results accumulator -----------------------------------------------
$gates  = New-Object System.Collections.Generic.List[object]
$reds   = 0
$yellows = 0

function Add-Gate {
  param(
    [string]$Name,
    [ValidateSet("GREEN","YELLOW","RED")]
    [string]$Status,
    [string]$Detail
  )
  $row = [pscustomobject]@{
    gate   = $Name
    status = $Status
    detail = $Detail
    at     = (Get-Date).ToString("o")
  }
  $gates.Add($row) | Out-Null
  $color = switch ($Status) { "GREEN" {"Green"} "YELLOW" {"Yellow"} "RED" {"Red"} }
  Write-Host ("[{0,-6}] {1,-40} {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
  if ($Status -eq "RED")    { $script:reds++ }
  if ($Status -eq "YELLOW") { $script:yellows++ }
}

function Test-HttpHealthz {
  param([string]$Url, [int]$TimeoutSec = 5)
  try {
    $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    return [pscustomobject]@{ ok = ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300); code = $r.StatusCode; body = $r.Content }
  } catch {
    return [pscustomobject]@{ ok = $false; code = 0; body = $_.Exception.Message }
  }
}

function Test-ContainerRunning {
  param([string]$Name)
  $out = & docker ps --filter "name=^/$Name$" --format "{{.Names}}" 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($out -eq $Name)
}

function Get-LatestSnapshot {
  param([string]$Dir, [string]$Pattern)
  if (-not (Test-Path $Dir)) { return $null }
  $f = Get-ChildItem -Path $Dir -Filter $Pattern -File -ErrorAction SilentlyContinue |
       Sort-Object LastWriteTime -Descending |
       Select-Object -First 1
  return $f
}

function Test-SnapshotFresh {
  param($File, [int]$MaxAgeHrs)
  if ($null -eq $File) { return $false }
  if ($File.Length -le 0) { return $false }
  $age = (Get-Date) - $File.LastWriteTime
  return ($age.TotalHours -le $MaxAgeHrs)
}

Write-Host "=== Codexa migration preflight ===" -ForegroundColor Cyan
$waveLabel = if ($Wave) { $Wave } else { "(unspecified)" }
Write-Host ("Wave:           {0}" -f $waveLabel)
Write-Host ("AuthorizeKill:  {0}" -f $AuthorizeKill.IsPresent)
Write-Host ("BackupRoot:     {0}" -f $BackupRoot)
Write-Host ("MaxSnapshotAge: {0} hrs" -f $MaxSnapshotAgeHrs)
Write-Host ("DryRun:         {0}" -f $DryRun.IsPresent)
Write-Host ""

# --- Fatal pre-flight: receipt dir + docker reachable -----------------------
try {
  if (-not (Test-Path $RECEIPT_DIR)) {
    if (-not $DryRun) { New-Item -ItemType Directory -Path $RECEIPT_DIR -Force | Out-Null }
  }
  if (-not (Test-Path $BackupRoot)) {
    Write-Host "[FATAL] BackupRoot does not exist: $BackupRoot" -ForegroundColor Red
    exit 2
  }
} catch {
  Write-Host "[FATAL] cannot prepare receipt/backup paths: $($_.Exception.Message)" -ForegroundColor Red
  exit 2
}

try { $null = & docker info 2>$null } catch {}
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FATAL] docker daemon unreachable -- cannot evaluate legacy state" -ForegroundColor Red
  exit 2
}

# --- Gate 1: legacy containers enumerable -----------------------------------
$legacyState = @{}
foreach ($k in $LEGACY.Keys) {
  $running = Test-ContainerRunning -Name $LEGACY[$k]
  $legacyState[$k] = $running
}
$enumerable = $true
foreach ($k in $LEGACY.Keys) {
  if ($null -eq $legacyState[$k]) { $enumerable = $false; break }
}
if ($enumerable) {
  $running = ($legacyState.GetEnumerator() | Where-Object { $_.Value } | ForEach-Object { $_.Key }) -join ","
  Add-Gate -Name "docker.legacy.enumerable" -Status "GREEN" -Detail "running: [$running]"
} else {
  Add-Gate -Name "docker.legacy.enumerable" -Status "RED" -Detail "docker ps failed for one or more legacy names"
}

# --- Gate 2: Atomic Orange installer green ----------------------------------
$ao = Test-HttpHealthz -Url $ATOMIC_ORANGE_PROBE
if ($ao.ok) {
  Add-Gate -Name "atomic-orange.installer.green" -Status "GREEN" -Detail "$ATOMIC_ORANGE_PROBE -> $($ao.code)"
} else {
  Add-Gate -Name "atomic-orange.installer.green" -Status "RED" -Detail "no green from $ATOMIC_ORANGE_PROBE ($($ao.body))"
}

# --- Gate 3: Hermes daemon LIVE ---------------------------------------------
$hermes = Test-HttpHealthz -Url $HERMES_PROBE
if ($hermes.ok) {
  Add-Gate -Name "hermes.daemon.live" -Status "GREEN" -Detail "$HERMES_PROBE -> $($hermes.code)"
} else {
  Add-Gate -Name "hermes.daemon.live" -Status "RED" -Detail "no green from $HERMES_PROBE ($($hermes.body))"
}

# --- Gate 4: Vault lane LIVE + Mirage StateBrief reachable ------------------
$vault = Test-HttpHealthz -Url $VAULT_PROBE
if (-not $vault.ok) {
  Add-Gate -Name "vault.lane.live" -Status "RED" -Detail "no green from $VAULT_PROBE ($($vault.body))"
} else {
  Add-Gate -Name "vault.lane.live" -Status "GREEN" -Detail "$VAULT_PROBE -> $($vault.code)"
  $mirage = Test-HttpHealthz -Url $MIRAGE_PROBE
  if ($mirage.ok -and $mirage.body -and $mirage.body.Length -gt 0) {
    Add-Gate -Name "vault.mirage.statebrief" -Status "GREEN" -Detail "StateBrief served ($($mirage.body.Length) bytes)"
  } else {
    Add-Gate -Name "vault.mirage.statebrief" -Status "RED" -Detail "Mirage StateBrief missing or empty at $MIRAGE_PROBE"
  }
}

# --- Gate 5: Qdrant data backed up (KEEP, but snapshot still required) ------
$qSnap = Get-LatestSnapshot -Dir (Join-Path $BackupRoot "qdrant") -Pattern "qdrant-*.tar*"
if (Test-SnapshotFresh -File $qSnap -MaxAgeHrs $MaxSnapshotAgeHrs) {
  Add-Gate -Name "qdrant.backup.fresh" -Status "GREEN" -Detail "$($qSnap.Name) ($([math]::Round($qSnap.Length/1MB,1)) MB)"
} else {
  $detail = if ($null -eq $qSnap) { "no qdrant snapshot found in $BackupRoot\qdrant" }
            else { "stale: $($qSnap.Name) age $([math]::Round(((Get-Date)-$qSnap.LastWriteTime).TotalHours,1))h > $MaxSnapshotAgeHrs" }
  Add-Gate -Name "qdrant.backup.fresh" -Status "RED" -Detail $detail
}

# --- Gate 6: Postgres volume snapshot ---------------------------------------
$pSnap = Get-LatestSnapshot -Dir (Join-Path $BackupRoot "postgres") -Pattern "postgres-*.tar*"
if (Test-SnapshotFresh -File $pSnap -MaxAgeHrs $MaxSnapshotAgeHrs) {
  Add-Gate -Name "postgres.backup.fresh" -Status "GREEN" -Detail "$($pSnap.Name) ($([math]::Round($pSnap.Length/1MB,1)) MB)"
} else {
  $detail = if ($null -eq $pSnap) { "no postgres snapshot in $BackupRoot\postgres" }
            else { "stale: $($pSnap.Name) age $([math]::Round(((Get-Date)-$pSnap.LastWriteTime).TotalHours,1))h > $MaxSnapshotAgeHrs" }
  Add-Gate -Name "postgres.backup.fresh" -Status "RED" -Detail $detail
}

# --- Gate 7: Redis volume snapshot ------------------------------------------
$rSnap = Get-LatestSnapshot -Dir (Join-Path $BackupRoot "redis") -Pattern "redis-*.tar*"
if (Test-SnapshotFresh -File $rSnap -MaxAgeHrs $MaxSnapshotAgeHrs) {
  Add-Gate -Name "redis.backup.fresh" -Status "GREEN" -Detail "$($rSnap.Name) ($([math]::Round($rSnap.Length/1MB,1)) MB)"
} else {
  $detail = if ($null -eq $rSnap) { "no redis snapshot in $BackupRoot\redis" }
            else { "stale: $($rSnap.Name) age $([math]::Round(((Get-Date)-$rSnap.LastWriteTime).TotalHours,1))h > $MaxSnapshotAgeHrs" }
  Add-Gate -Name "redis.backup.fresh" -Status "RED" -Detail $detail
}

# --- Gate 8: Authorization gate ---------------------------------------------
$killSet = @()
$authDetail = ""
if (-not $Wave) {
  Add-Gate -Name "authorization.wave" -Status "RED" -Detail "-Wave W1|W2 not specified"
} else {
  $killSet = $KILL_SET[$Wave]
  if (-not $AuthorizeKill) {
    Add-Gate -Name "authorization.killflag" -Status "YELLOW" -Detail "wave $Wave staged but -AuthorizeKill absent (DRY)"
  } else {
    # Confirm the targeted kill set matches what's actually running -- killing
    # something already dead is fine, but we must not be silently authorizing
    # a kill of a container the operator does not know is up.
    $live = @($killSet | Where-Object { $legacyState[$_] -eq $true })
    $authDetail = "wave $Wave kill set: [$($killSet -join ',')]; currently live: [$($live -join ',')]"
    Add-Gate -Name "authorization.killflag" -Status "GREEN" -Detail $authDetail
  }
}

# --- Verdict ----------------------------------------------------------------
Write-Host ""
$verdict = if ($reds -gt 0) { "RED" }
           elseif (-not $AuthorizeKill -or -not $Wave) { "DRY" }
           else { "GREEN" }

Write-Host ("=== Verdict: {0}  (reds={1} yellows={2}) ===" -f $verdict, $reds, $yellows) `
  -ForegroundColor $(switch ($verdict) { "GREEN" {"Green"} "DRY" {"Yellow"} "RED" {"Red"} })

# --- Receipt ----------------------------------------------------------------
$receipt = [pscustomobject]@{
  schema       = "codexa-migration.preflight.v1"
  generated_at = (Get-Date).ToString("o")
  operator     = "Atom McCree"
  wave         = $Wave
  authorized   = [bool]$AuthorizeKill
  verdict      = $verdict
  reds         = $reds
  yellows      = $yellows
  kill_set     = $killSet
  legacy_state = $legacyState
  gates        = $gates
  doctrine     = @{
    moms_law         = $true
    no_take_down_law = $true
    receipt_ref      = "#013"
  }
}

if (-not $DryRun) {
  $json = $receipt | ConvertTo-Json -Depth 8
  Set-Content -Path $RECEIPT_PATH -Value $json -Encoding UTF8
  Write-Host "Receipt: $RECEIPT_PATH"
} else {
  Write-Host "(DryRun) receipt NOT written"
}

# --- Exit -------------------------------------------------------------------
if ($verdict -eq "GREEN") { exit 0 }
exit 1
