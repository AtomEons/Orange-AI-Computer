# 01-rollback-open-webui.ps1
# Codexa migration W1 step 1 -- rollback companion.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: receipts only, no theater.
#   - This script only writes destructive Docker state when -Force is given.
#     Without -Force it is a planning / verification dry run.
#
# What it does:
#   1. Locate the most recent open-webui backup in C:\opt\atomeons\migrations\
#      (or the path passed via -BackupTar). Verify SHA-256 against sidecar.
#   2. Read the matching .meta.json to recover image, restart policy, and
#      the original named-volume name.
#   3. Refuse to proceed if a container with the same name already exists
#      (operator must remove it first; preventing accidental clobber).
#   4. Recreate the named volume (or reuse it if empty) and restore the
#      tarball contents into it via a throwaway busybox container.
#   5. docker run -d the original image with the original name, restart
#      policy, port bindings (if any captured), and volume mount.
#   6. Verify the container reaches "running" state; otherwise red.
#   7. Emit a Markdown rollback receipt.
#
# Flags:
#   -BackupTar      : explicit tarball path. Default: newest *.tar.gz under
#                     C:\opt\atomeons\migrations\ matching open-webui-*.
#   -ContainerName  : name to restore as. Default
#                     aeorangebox-ai-box-open-webui-1.
#   -Force          : REQUIRED for destructive steps (volume create, restore,
#                     docker run). Without -Force this script validates the
#                     archive and prints the plan.
#   -DryRun         : alias for "no -Force"; still runs validation reads.
#
# Exit codes:
#   0  success or planning run.
#   1  one or more steps failed.
#   2  fatal pre-flight (docker missing, no backup found, name collision).

[CmdletBinding()]
param(
  [string]$BackupTar = "",
  [string]$ContainerName = "aeorangebox-ai-box-open-webui-1",
  [switch]$Force,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ORANGE5_ROOT       = "C:\AtomEons\Orange5"
$RECEIPT_DIR        = Join-Path $ORANGE5_ROOT "10-RECEIPTS\codexa-migration"
$MIGRATION_ROOT_WIN = "C:\opt\atomeons\migrations"
$TS_UTC             = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$RECEIPT_PATH       = Join-Path $RECEIPT_DIR ("{0}-w1-rollback-open-webui.md" -f (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd"))

# DryRun is the inverse of Force; -DryRun is provided for symmetry with kill script.
if ($DryRun -and $Force) {
  Write-Host "FATAL: -DryRun and -Force are mutually exclusive." -ForegroundColor Red
  exit 2
}
$willMutate = $Force.IsPresent

$steps = New-Object System.Collections.Generic.List[object]
function Add-Step {
  param([string]$Phase,[string]$Title,[ValidateSet("green","yellow","red","skip")][string]$Status,[string]$Detail="")
  $steps.Add([pscustomobject]@{ phase=$Phase; title=$Title; status=$Status; detail=$Detail; ts=(Get-Date).ToUniversalTime().ToString("o") }) | Out-Null
  $color = switch ($Status) { "green"{"Green"} "yellow"{"Yellow"} "red"{"Red"} "skip"{"DarkGray"} }
  Write-Host ("[{0}] {1} -- {2} :: {3}" -f $Phase, $Status.ToUpper(), $Title, $Detail) -ForegroundColor $color
}
function Banner([string]$msg) { Write-Host ""; Write-Host ("===== {0} =====" -f $msg) -ForegroundColor Cyan }
function Has-Red { return ($steps | Where-Object { $_.status -eq "red" }).Count -gt 0 }

function Test-DockerAvailable {
  try { docker version --format '{{.Server.Version}}' 1>$null 2>$null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}
function Get-FileSha256([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}

# --- Phase 0 ----------------------------------------------------------------
Banner "PHASE 0 -- pre-flight"
if (-not (Test-DockerAvailable)) { Add-Step "0" "docker available" "red" "docker version failed"; exit 2 }
Add-Step "0" "docker available" "green" ""

if (-not (Test-Path -LiteralPath $RECEIPT_DIR)) {
  if ($willMutate) { New-Item -ItemType Directory -Force -Path $RECEIPT_DIR | Out-Null }
}

# Find backup tarball
if ([string]::IsNullOrWhiteSpace($BackupTar)) {
  $candidates = Get-ChildItem -LiteralPath $MIGRATION_ROOT_WIN -Filter "open-webui-*.tar.gz" -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending
  if (-not $candidates) { Add-Step "0" "locate backup" "red" ("no open-webui-*.tar.gz under {0}" -f $MIGRATION_ROOT_WIN); exit 2 }
  $BackupTar = $candidates[0].FullName
}
if (-not (Test-Path -LiteralPath $BackupTar)) { Add-Step "0" "locate backup" "red" ("tarball not found: {0}" -f $BackupTar); exit 2 }
Add-Step "0" "locate backup" "green" $BackupTar

# Verify sha sidecar
$shaSidecar = "{0}.sha256" -f $BackupTar
$shaActual = Get-FileSha256 $BackupTar
if (Test-Path -LiteralPath $shaSidecar) {
  $shaExpectedLine = (Get-Content -LiteralPath $shaSidecar -TotalCount 1)
  $shaExpected = ($shaExpectedLine -split '\s+')[0].ToLowerInvariant()
  if ($shaExpected -eq $shaActual) {
    Add-Step "0" "sha256 verify" "green" $shaActual
  } else {
    Add-Step "0" "sha256 verify" "red" ("expected={0} actual={1}" -f $shaExpected, $shaActual)
    exit 1
  }
} else {
  Add-Step "0" "sha256 verify" "yellow" ("no sidecar at {0}; computed={1}" -f $shaSidecar, $shaActual)
}

# Load meta.json
$metaPath = $BackupTar -replace '\.tar\.gz$','.meta.json'
if (-not (Test-Path -LiteralPath $metaPath)) { Add-Step "0" "load meta.json" "red" ("missing {0}" -f $metaPath); exit 2 }
$meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
Add-Step "0" "load meta.json" "green" ("image={0} restart={1}" -f $meta.image, $meta.restart_policy)

# Name collision check
$existing = docker ps -a --filter ("name=^/{0}$" -f $ContainerName) --format '{{.Names}}' 2>$null
if ($existing -eq $ContainerName) {
  Add-Step "0" "name collision" "red" ("'{0}' already exists; remove it first" -f $ContainerName)
  exit 2
}
Add-Step "0" "name collision" "green" "name is free"

# --- Phase 1: restore volume ------------------------------------------------
Banner "PHASE 1 -- restore named volume"
$volName = if ($meta.named_volumes -and $meta.named_volumes.Count -gt 0) { $meta.named_volumes[0] } else { $null }
if (-not $volName) {
  Add-Step "1" "volume restore" "yellow" "no named volume in meta; container had ephemeral or bind storage"
} else {
  if (-not $willMutate) {
    Add-Step "1" "volume restore (planned)" "yellow" ("docker volume create {0}; busybox tar -xz from {1}" -f $volName, $BackupTar)
  } else {
    & docker volume create $volName | Out-Null
    if ($LASTEXITCODE -ne 0) { Add-Step "1" "docker volume create" "red" ("exit={0}" -f $LASTEXITCODE); exit 1 }

    # Refuse to clobber a non-empty volume.
    $probe = docker run --rm -v ("{0}:/data" -f $volName) busybox sh -c "ls -A /data | head -1" 2>$null
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($probe)) {
      Add-Step "1" "volume empty check" "red" ("volume '{0}' is not empty; refusing to overwrite" -f $volName)
      exit 1
    }
    Add-Step "1" "volume empty check" "green" ("'{0}' is empty" -f $volName)

    $tarName = Split-Path -Leaf $BackupTar
    & docker run --rm `
      -v ("{0}:/data" -f $volName) `
      -v ("{0}:/backup:ro" -f $MIGRATION_ROOT_WIN) `
      busybox sh -c ("cd /data && tar xzf /backup/{0}" -f $tarName)
    if ($LASTEXITCODE -ne 0) { Add-Step "1" "tar extract" "red" ("exit={0}" -f $LASTEXITCODE); exit 1 }
    Add-Step "1" "tar extract" "green" ("restored into volume '{0}'" -f $volName)
  }
}

# --- Phase 2: recreate container -------------------------------------------
Banner "PHASE 2 -- recreate container"
$restart = if ($meta.restart_policy) { $meta.restart_policy } else { "unless-stopped" }
$image   = $meta.image
$mountArg = if ($volName) { @("-v", ("{0}:/app/backend/data" -f $volName)) } else { @() }
# Note: /app/backend/data is the canonical open-webui data mount; if the
# original mount target differs the operator should pass the captured target
# from inspect output. We restore to the documented default.

if (-not $willMutate) {
  Add-Step "2" "docker run (planned)" "yellow" ("docker run -d --name {0} --restart {1} {2} {3}" -f $ContainerName, $restart, ($mountArg -join ' '), $image)
} else {
  $runArgs = @("run","-d","--name",$ContainerName,"--restart",$restart) + $mountArg + @($image)
  & docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { Add-Step "2" "docker run" "red" ("exit={0}" -f $LASTEXITCODE); exit 1 }
  Start-Sleep -Seconds 3
  $running = docker inspect -f '{{.State.Running}}' $ContainerName 2>$null
  if ($running -eq "true") {
    Add-Step "2" "container running" "green" $ContainerName
  } else {
    Add-Step "2" "container running" "red" ("inspect Running={0}" -f $running)
    exit 1
  }
}

# --- Phase 3: receipt -------------------------------------------------------
Banner "PHASE 3 -- receipt"
$rc = New-Object System.Collections.Generic.List[string]
$rc.Add("# Codexa migration W1 -- rollback open-webui") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("- Date (UTC): {0}" -f $TS_UTC)) | Out-Null
$rc.Add(("- Restored from: ``{0}``" -f $BackupTar)) | Out-Null
$rc.Add(("- SHA-256: ``{0}``" -f $shaActual)) | Out-Null
$rc.Add(("- Container: ``{0}``" -f $ContainerName)) | Out-Null
$rc.Add(("- Image: ``{0}``" -f $image)) | Out-Null
$rc.Add(("- Volume: ``{0}``" -f $volName)) | Out-Null
$rc.Add(("- Mutated state: {0}" -f $willMutate)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| Phase | Status | Title | Detail |") | Out-Null
$rc.Add("|-------|--------|-------|--------|") | Out-Null
foreach ($s in $steps) {
  $detail = ($s.detail -replace '\|','\\|')
  $rc.Add(("| {0} | {1} | {2} | {3} |" -f $s.phase, $s.status, $s.title, $detail)) | Out-Null
}

if ($willMutate) {
  Set-Content -LiteralPath $RECEIPT_PATH -Value ($rc -join "`n") -Encoding utf8
  Write-Host ("Receipt: {0}" -f $RECEIPT_PATH) -ForegroundColor Green
} else {
  Write-Host "Planning run -- receipt NOT written. Re-run with -Force to commit." -ForegroundColor Yellow
}

if (Has-Red) { exit 1 }
exit 0
