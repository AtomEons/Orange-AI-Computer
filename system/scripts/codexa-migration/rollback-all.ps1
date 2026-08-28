# rollback-all.ps1
# Codexa migration -- master rollback. UNDO every kill in reverse order.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: every destructive op must have a rollback. This is it.
#   - No-Take-Down Law: this script touches Docker state only when -Force is
#     given. Without -Force it validates backups and prints a per-target plan.
#   - Receipts only. Every phase gets a green/yellow/red row.
#
# Kill order (forward):
#   W1: 01-kill-open-webui.ps1   -> retires aeorangebox-ai-box-open-webui-1
#   W1: 02-kill-n8n.ps1          -> retires aeorangebox-ai-box-n8n-1
#   W2: 03-kill-wiki.ps1         -> retires aeorangebox-ai-box-wiki-1
#   W2: 04-evaluate-pg-redis.ps1 -> evaluation only (verdict);
#                                   if verdict was SAFE-TO-KILL and operator
#                                   followed through, backups will exist for
#                                   aeorangebox-ai-box-postgres-1 and -redis-1.
#   KEEP: aeorangebox-ai-box-qdrant-1 (never killed -> never restored).
#
# Rollback order (reverse) -- this script:
#   1. postgres   (if backup exists)
#   2. redis      (if backup exists)
#   3. wiki
#   4. n8n
#   5. open-webui
#
# For each target, the routine mirrors 01-rollback-open-webui.ps1:
#   * locate newest <prefix>-*.tar.gz in C:\opt\atomeons\migrations\
#     (-MigrationRoot to override)
#   * verify SHA-256 against .sha256 sidecar; YELLOW if missing, RED on mismatch
#   * load <prefix>-*.meta.json (image, restart_policy, named_volumes, mounts)
#   * refuse if a container with that name already exists (name collision)
#   * docker volume create + busybox tar xzf into volume(s)
#   * docker run -d with original image, restart policy, and mounts
#   * verify State.Running == true
#
# Flags:
#   -Force            : REQUIRED for destructive Docker operations.
#                       Without -Force this is a planning / verification run.
#   -DryRun           : alias for "no -Force"; runs validation reads only.
#   -MigrationRoot    : default C:\opt\atomeons\migrations
#   -Only             : comma-separated subset of {open-webui,n8n,wiki,postgres,redis}
#                       to restore. Default: all that have backups.
#   -Skip             : comma-separated subset to NOT restore. Applied after -Only.
#   -StopOnRed        : stop the chain on the first red target.
#                       Default: continue to next target so the operator sees
#                       the full damage picture in one receipt.
#
# Exit codes:
#   0  success or planning run (no reds).
#   1  one or more targets failed.
#   2  fatal pre-flight (docker missing, no backups at all, bad args).

[CmdletBinding()]
param(
  [switch]$Force,
  [switch]$DryRun,
  [string]$MigrationRoot = "C:\opt\atomeons\migrations",
  [string]$Only = "",
  [string]$Skip = "",
  [switch]$StopOnRed
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ORANGE5_ROOT = "C:\AtomEons\Orange5"
$RECEIPT_DIR  = Join-Path $ORANGE5_ROOT "10-RECEIPTS\codexa-migration"
$DATE_STAMP_UTC = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$TS_UTC         = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$RECEIPT_PATH = Join-Path $RECEIPT_DIR ("{0}-rollback-all.md" -f $DATE_STAMP_UTC)

if ($DryRun -and $Force) {
  Write-Host "FATAL: -DryRun and -Force are mutually exclusive." -ForegroundColor Red
  exit 2
}
$willMutate = $Force.IsPresent

# Rollback order: reverse of kill order. pg/redis first because they were the
# last things potentially killed (W2 evaluate). Then wiki (W2), n8n (W1),
# open-webui (W1). Latest-killed = first-restored.
$ALL_TARGETS = @(
  @{ key="postgres";   prefix="postgres";   container="aeorangebox-ai-box-postgres-1";   mountTarget="/var/lib/postgresql/data" },
  @{ key="redis";      prefix="redis";      container="aeorangebox-ai-box-redis-1";      mountTarget="/data" },
  @{ key="wiki";       prefix="wiki";       container="aeorangebox-ai-box-wiki-1";       mountTarget="/wiki/data" },
  @{ key="n8n";        prefix="n8n";        container="aeorangebox-ai-box-n8n-1";        mountTarget="/home/node/.n8n" },
  @{ key="open-webui"; prefix="open-webui"; container="aeorangebox-ai-box-open-webui-1"; mountTarget="/app/backend/data" }
)

# Apply -Only / -Skip filters.
$onlySet = @()
if ($Only -and $Only.Trim()) { $onlySet = $Only.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
$skipSet = @()
if ($Skip -and $Skip.Trim()) { $skipSet = $Skip.Split(",") | ForEach-Object { $_.Trim() } | Where-Object { $_ } }

$validKeys = $ALL_TARGETS | ForEach-Object { $_.key }
foreach ($k in @($onlySet + $skipSet)) {
  if ($k -and ($validKeys -notcontains $k)) {
    Write-Host ("FATAL: unknown target '{0}'. Valid: {1}" -f $k, ($validKeys -join ",")) -ForegroundColor Red
    exit 2
  }
}
$targets = $ALL_TARGETS | Where-Object {
  ($onlySet.Count -eq 0 -or $onlySet -contains $_.key) -and ($skipSet -notcontains $_.key)
}

$steps = New-Object System.Collections.Generic.List[object]
function Add-Step {
  param(
    [string]$Target,
    [string]$Phase,
    [string]$Title,
    [ValidateSet("green","yellow","red","skip")][string]$Status,
    [string]$Detail=""
  )
  $steps.Add([pscustomobject]@{
    target = $Target
    phase  = $Phase
    title  = $Title
    status = $Status
    detail = $Detail
    ts     = (Get-Date).ToUniversalTime().ToString("o")
  }) | Out-Null
  $color = switch ($Status) { "green"{"Green"} "yellow"{"Yellow"} "red"{"Red"} "skip"{"DarkGray"} }
  Write-Host ("[{0}|{1}] {2} -- {3} :: {4}" -f $Target, $Phase, $Status.ToUpper(), $Title, $Detail) -ForegroundColor $color
}
function Banner([string]$msg) { Write-Host ""; Write-Host ("===== {0} =====" -f $msg) -ForegroundColor Cyan }
function Test-DockerAvailable {
  try { docker version --format '{{.Server.Version}}' 1>$null 2>$null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}
function Get-FileSha256([string]$p) {
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  return (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Target-Reds([string]$key) {
  return ($steps | Where-Object { $_.target -eq $key -and $_.status -eq "red" }).Count
}
function Any-Reds { return ($steps | Where-Object { $_.status -eq "red" }).Count -gt 0 }

# --- Phase 0 -- global pre-flight -------------------------------------------
Banner "PHASE 0 -- global pre-flight"
if (-not (Test-DockerAvailable)) {
  Add-Step "*" "0" "docker available" "red" "docker version failed"
  exit 2
}
Add-Step "*" "0" "docker available" "green" ""

if (-not (Test-Path -LiteralPath $MigrationRoot)) {
  Add-Step "*" "0" "migration root" "red" ("missing: {0}" -f $MigrationRoot)
  exit 2
}
Add-Step "*" "0" "migration root" "green" $MigrationRoot

if (-not (Test-Path -LiteralPath $RECEIPT_DIR)) {
  if ($willMutate) {
    New-Item -ItemType Directory -Force -Path $RECEIPT_DIR | Out-Null
  }
}

if ($targets.Count -eq 0) {
  Add-Step "*" "0" "target list" "red" "no targets selected after -Only/-Skip"
  exit 2
}
Add-Step "*" "0" "target list" "green" (($targets | ForEach-Object { $_.key }) -join " -> ")

# --- per-target restore -----------------------------------------------------
function Invoke-Restore {
  param([hashtable]$t)

  $key       = $t.key
  $prefix    = $t.prefix
  $container = $t.container
  $mount     = $t.mountTarget

  Banner ("TARGET: {0} ({1})" -f $key, $container)

  # 1. locate newest tarball
  $candidates = Get-ChildItem -LiteralPath $MigrationRoot -Filter ("{0}-*.tar.gz" -f $prefix) -ErrorAction SilentlyContinue |
                Where-Object { $_.Name -notlike "*.meta.json*" } |
                Sort-Object LastWriteTime -Descending
  if (-not $candidates) {
    Add-Step $key "1" "locate backup" "skip" ("no {0}-*.tar.gz under {1}; target was never killed" -f $prefix, $MigrationRoot)
    return
  }
  $backupTar = $candidates[0].FullName
  Add-Step $key "1" "locate backup" "green" $backupTar

  # 2. verify SHA-256
  $shaSidecar = "{0}.sha256" -f $backupTar
  $shaActual  = Get-FileSha256 $backupTar
  if (Test-Path -LiteralPath $shaSidecar) {
    $shaExpectedLine = (Get-Content -LiteralPath $shaSidecar -TotalCount 1)
    $shaExpected = ($shaExpectedLine -split '\s+')[0].ToLowerInvariant()
    if ($shaExpected -eq $shaActual) {
      Add-Step $key "2" "sha256 verify" "green" $shaActual
    } else {
      Add-Step $key "2" "sha256 verify" "red" ("expected={0} actual={1}" -f $shaExpected, $shaActual)
      return
    }
  } else {
    Add-Step $key "2" "sha256 verify" "yellow" ("no sidecar; computed={0}" -f $shaActual)
  }

  # 3. load meta.json
  $metaPath = $backupTar -replace '\.tar\.gz$','.meta.json'
  if (-not (Test-Path -LiteralPath $metaPath)) {
    Add-Step $key "3" "load meta.json" "red" ("missing: {0}" -f $metaPath)
    return
  }
  try {
    $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
  } catch {
    Add-Step $key "3" "load meta.json" "red" ("parse failed: {0}" -f $_.Exception.Message)
    return
  }
  $image = $meta.image
  if ([string]::IsNullOrWhiteSpace($image)) {
    Add-Step $key "3" "load meta.json" "red" "image field empty"
    return
  }
  $restart = if ($meta.PSObject.Properties.Name -contains "restart_policy" -and $meta.restart_policy) { $meta.restart_policy } else { "unless-stopped" }
  Add-Step $key "3" "load meta.json" "green" ("image={0} restart={1}" -f $image, $restart)

  # 4. name collision check
  $existing = docker ps -a --filter ("name=^/{0}$" -f $container) --format '{{.Names}}' 2>$null
  if ($existing -eq $container) {
    Add-Step $key "4" "name collision" "red" ("'{0}' already exists; remove it first" -f $container)
    return
  }
  Add-Step $key "4" "name collision" "green" "name is free"

  # 5. restore volume
  $volName = $null
  if ($meta.PSObject.Properties.Name -contains "named_volumes" -and $meta.named_volumes -and $meta.named_volumes.Count -gt 0) {
    $volName = $meta.named_volumes[0]
  }
  if (-not $volName) {
    Add-Step $key "5" "volume restore" "yellow" "no named volume in meta; ephemeral or bind storage"
  } else {
    if (-not $willMutate) {
      Add-Step $key "5" "volume restore (planned)" "yellow" ("docker volume create {0}; busybox tar -xz from {1}" -f $volName, $backupTar)
    } else {
      & docker volume create $volName | Out-Null
      if ($LASTEXITCODE -ne 0) { Add-Step $key "5" "docker volume create" "red" ("exit={0}" -f $LASTEXITCODE); return }

      # refuse to clobber non-empty volume
      $probe = docker run --rm -v ("{0}:/data" -f $volName) busybox sh -c "ls -A /data | head -1" 2>$null
      if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($probe)) {
        Add-Step $key "5" "volume empty check" "red" ("volume '{0}' is not empty; refusing to overwrite" -f $volName)
        return
      }
      Add-Step $key "5" "volume empty check" "green" ("'{0}' is empty" -f $volName)

      $tarName = Split-Path -Leaf $backupTar
      & docker run --rm `
        -v ("{0}:/data" -f $volName) `
        -v ("{0}:/backup:ro" -f $MigrationRoot) `
        busybox sh -c ("cd /data && tar xzf /backup/{0}" -f $tarName)
      if ($LASTEXITCODE -ne 0) { Add-Step $key "5" "tar extract" "red" ("exit={0}" -f $LASTEXITCODE); return }
      Add-Step $key "5" "tar extract" "green" ("restored into volume '{0}'" -f $volName)
    }
  }

  # 6. recreate container
  $mountArg = if ($volName) { @("-v", ("{0}:{1}" -f $volName, $mount)) } else { @() }
  if (-not $willMutate) {
    Add-Step $key "6" "docker run (planned)" "yellow" ("docker run -d --name {0} --restart {1} {2} {3}" -f $container, $restart, ($mountArg -join ' '), $image)
  } else {
    $runArgs = @("run","-d","--name",$container,"--restart",$restart) + $mountArg + @($image)
    & docker @runArgs | Out-Null
    if ($LASTEXITCODE -ne 0) { Add-Step $key "6" "docker run" "red" ("exit={0}" -f $LASTEXITCODE); return }
    Start-Sleep -Seconds 3
    $running = docker inspect -f '{{.State.Running}}' $container 2>$null
    if ($running -eq "true") {
      Add-Step $key "6" "container running" "green" $container
    } else {
      Add-Step $key "6" "container running" "red" ("inspect Running={0}" -f $running)
      return
    }
  }

  Add-Step $key "7" "restore complete" "green" ""
}

foreach ($t in $targets) {
  Invoke-Restore -t $t
  if ($StopOnRed -and (Target-Reds $t.key) -gt 0) {
    Add-Step "*" "*" "stop on red" "red" ("halting after target '{0}'" -f $t.key)
    break
  }
}

# --- receipt ----------------------------------------------------------------
Banner "RECEIPT"
$rc = New-Object System.Collections.Generic.List[string]
$rc.Add("# Codexa migration -- ROLLBACK ALL") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("- Date (UTC): {0}" -f $TS_UTC)) | Out-Null
$rc.Add(("- Migration root: ``{0}``" -f $MigrationRoot)) | Out-Null
$rc.Add(("- Mutated state: {0}" -f $willMutate)) | Out-Null
$rc.Add(("- Targets (reverse-kill order): {0}" -f (($targets | ForEach-Object { $_.key }) -join " -> "))) | Out-Null
$rc.Add(("- StopOnRed: {0}" -f $StopOnRed.IsPresent)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add("Doctrine:") | Out-Null
$rc.Add("- Mom's Law: every destructive op has a rollback. This is the rollback.") | Out-Null
$rc.Add("- No-Take-Down Law: no docker mutation without -Force.") | Out-Null
$rc.Add("- Qdrant is KEEP-FOREVER and is never restored by this script.") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| Target | Phase | Status | Title | Detail |") | Out-Null
$rc.Add("|--------|-------|--------|-------|--------|") | Out-Null
foreach ($s in $steps) {
  $detail = ($s.detail -replace '\|','\\|')
  $rc.Add(("| {0} | {1} | {2} | {3} | {4} |" -f $s.target, $s.phase, $s.status, $s.title, $detail)) | Out-Null
}

# Per-target summary tail
$rc.Add("") | Out-Null
$rc.Add("## Per-target summary") | Out-Null
foreach ($t in $ALL_TARGETS) {
  $reds = ($steps | Where-Object { $_.target -eq $t.key -and $_.status -eq "red" }).Count
  $skips = ($steps | Where-Object { $_.target -eq $t.key -and $_.status -eq "skip" }).Count
  $touched = ($steps | Where-Object { $_.target -eq $t.key }).Count
  $verdict =
    if ($touched -eq 0)      { "not selected" }
    elseif ($skips -gt 0 -and $reds -eq 0) { "skipped (no backup)" }
    elseif ($reds -gt 0)     { "FAILED" }
    elseif (-not $willMutate){ "planning only" }
    else                     { "restored" }
  $rc.Add(("- ``{0}`` ({1}): {2}" -f $t.key, $t.container, $verdict)) | Out-Null
}

if ($willMutate) {
  Set-Content -LiteralPath $RECEIPT_PATH -Value ($rc -join "`n") -Encoding utf8
  Write-Host ("Receipt: {0}" -f $RECEIPT_PATH) -ForegroundColor Green
} else {
  Write-Host "Planning run -- receipt NOT written. Re-run with -Force to commit." -ForegroundColor Yellow
  Write-Host "Planned receipt (in memory):" -ForegroundColor DarkGray
  Write-Host (($rc -join "`n")) -ForegroundColor DarkGray
}

if (Any-Reds) { exit 1 }
exit 0
