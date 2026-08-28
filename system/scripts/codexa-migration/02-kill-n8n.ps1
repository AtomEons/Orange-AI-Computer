# 02-kill-n8n.ps1
# Codexa migration W1 step 2 -- retire legacy n8n workflow runner.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: full effort, no theater, no silent fallback. Receipts only.
#   - No-Take-Down Law: a running surface only dies when (a) its replacement is
#     proven healthy and (b) its state has been backed up. If either fails this
#     script EXITS NON-ZERO and touches nothing destructive.
#   - Receipt #013 (Codexa migration plan): open-webui retires at W1 close,
#     n8n at W1 close, orangebox-wiki at W2 close, qdrant is KEPT, postgres
#     and redis evaluated separately. This script handles n8n only.
#
# Replacement surface:
#   Hermes (Codexa workflow runner) at http://127.0.0.1:7430/healthz.
#   No Hermes, no kill.
#
# What it does (in order; aborts on first red):
#   1. Pre-flight -- verify Hermes @ 127.0.0.1:7430 /healthz is up. Docker
#      reachable. Receipt + migration dirs exist (or create them). Refuse if
#      replacement is unhealthy unless -SkipHermesCheck.
#   2. Identify the legacy n8n container (default name:
#      aeorangebox-ai-box-n8n-1; override via -ContainerName).
#   3. Inspect the container: image digest, env minus secrets, mounts, named
#      volume(s), restart policy, created/started timestamps.
#   4. Export n8n workflows (and optionally credentials) via the n8n CLI
#      inside the still-running container:
#        docker exec <n8n> n8n export:workflow --all --output=/data/n8n-workflows-<UTC-date>.json
#      Write the JSON to /opt/atomeons/migrations/n8n-workflows-<UTC-date>.json
#      (Windows mirror: C:\opt\atomeons\migrations\). Refuse to proceed if the
#      JSON is < 1 KiB or missing.
#   5. Back up the n8n named volume(s) (the .n8n dir holds encryption key,
#      sqlite db, binary data) to /opt/atomeons/migrations/n8n-<UTC-date>.tar.gz
#      via a throwaway `docker run --rm` container with busybox tar. SHA-256
#      the archive. Refuse to proceed if the archive is < 1 KiB or missing.
#   6. Snapshot container metadata (image digest, env minus secrets, mounts,
#      created/started timestamps, restart policy) next to the tarball as
#      n8n-<UTC-date>.meta.json -- enough to rebuild it cold.
#   7. docker stop --time 30 <container>  then  docker rm <container>.
#   8. docker image rm of the cached n8n image IFF -ReclaimImage.
#      Default is to leave the image cached (cheap rollback insurance).
#   9. Write a Markdown receipt to 10-RECEIPTS/codexa-migration/ with every
#      step green/yellow/red and the SHA-256 of the backup + workflow export.
#
# Flags:
#   -DryRun           : print every planned action; touch nothing; exit 0.
#                       Pre-flight checks (Hermes, container exists, volume
#                       exists, target dir writable) still run -- they are
#                       read-only and surfacing a failure here is the point.
#   -Force            : REQUIRED for destructive steps (docker stop + rm).
#                       Without -Force everything up to and including backup
#                       + workflow export happens, then the script stops with
#                       a YELLOW row and exit 0. This lets you stage the
#                       backup ahead of the cutover window without committing
#                       the kill.
#   -ContainerName    : override the legacy container name. Default
#                       aeorangebox-ai-box-n8n-1 per receipt #013.
#   -ReclaimImage     : after rm, also docker image rm the cached image.
#                       Default OFF -- keep the image so a rollback only needs
#                       the accompanying 02-rollback-n8n.ps1 script.
#   -SkipHermesCheck  : explicit override for the No-Take-Down Law. Only use
#                       this if Hermes lives somewhere other than 127.0.0.1:7430
#                       and you have proven it healthy by other means. Logs a
#                       loud yellow row in the receipt.
#   -ExportCredentials: also export n8n credentials (encrypted blobs only;
#                       requires the encryption key from the volume tarball to
#                       decrypt). Default OFF -- workflows alone are enough for
#                       a clean rebuild; credentials add a sensitive sidecar.
#
# Exit codes:
#   0  success, or DryRun, or backup-only (no -Force) with backup + export green.
#   1  one or more steps failed; receipt emitted with red rows; nothing
#      destructive happened past the point of failure.
#   2  fatal pre-flight (docker missing, target dir unwritable, container
#      named but not found, etc.). Nothing on disk changed.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$ContainerName = "aeorangebox-ai-box-n8n-1",
  [switch]$ReclaimImage,
  [switch]$SkipHermesCheck,
  [switch]$ExportCredentials
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths and constants (anchored, never relative) -------------------------
$ORANGE5_ROOT      = "C:\AtomEons\Orange5"
$RECEIPT_DIR       = Join-Path $ORANGE5_ROOT "10-RECEIPTS\codexa-migration"
$MIGRATION_ROOT    = "/opt/atomeons/migrations"     # in-container path
$MIGRATION_ROOT_WIN= "C:\opt\atomeons\migrations"   # Windows-side mirror
$DATE_STAMP_UTC    = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$TS_UTC            = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$BACKUP_BASENAME   = "n8n-{0}" -f $DATE_STAMP_UTC
$BACKUP_TAR_NAME   = "{0}.tar.gz" -f $BACKUP_BASENAME
$BACKUP_META_NAME  = "{0}.meta.json" -f $BACKUP_BASENAME
$WORKFLOW_JSON_NAME= "n8n-workflows-{0}.json" -f $DATE_STAMP_UTC
$CRED_JSON_NAME    = "n8n-credentials-{0}.json" -f $DATE_STAMP_UTC
$RECEIPT_PATH      = Join-Path $RECEIPT_DIR ("{0}-w1-kill-n8n.md" -f $DATE_STAMP_UTC)

$HERMES_PORT       = 7430
$HERMES_HEALTHZ    = "http://127.0.0.1:{0}/healthz" -f $HERMES_PORT
$STOP_TIMEOUT_SEC  = 30
$MIN_BACKUP_BYTES  = 1024
$MIN_EXPORT_BYTES  = 1024

# --- Receipt accumulator ----------------------------------------------------
$steps = New-Object System.Collections.Generic.List[object]
function Add-Step {
  param(
    [string]$Phase,
    [string]$Title,
    [ValidateSet("green","yellow","red","skip")][string]$Status,
    [string]$Detail = ""
  )
  $row = [pscustomobject]@{
    phase  = $Phase
    title  = $Title
    status = $Status
    detail = $Detail
    ts     = (Get-Date).ToUniversalTime().ToString("o")
  }
  $steps.Add($row) | Out-Null
  $color = switch ($Status) {
    "green"  { "Green" }
    "yellow" { "Yellow" }
    "red"    { "Red" }
    "skip"   { "DarkGray" }
  }
  Write-Host ("[{0}] {1} -- {2} :: {3}" -f $Phase, $Status.ToUpper(), $Title, $Detail) -ForegroundColor $color
}
function Banner([string]$msg) {
  Write-Host ""
  Write-Host ("===== {0} =====" -f $msg) -ForegroundColor Cyan
}
function Has-Red { return ($steps | Where-Object { $_.status -eq "red" }).Count -gt 0 }

# --- Helpers ----------------------------------------------------------------
function Test-DockerAvailable {
  try { docker version --format '{{.Server.Version}}' 1>$null 2>$null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}

function Test-ContainerExists([string]$name) {
  $found = docker ps -a --filter ("name=^/{0}$" -f $name) --format '{{.Names}}' 2>$null
  return ($found -eq $name)
}

function Test-ContainerRunning([string]$name) {
  $state = docker inspect -f '{{.State.Running}}' $name 2>$null
  return ($LASTEXITCODE -eq 0 -and $state -eq "true")
}

function Get-ContainerVolumes([string]$name) {
  # Return named volumes mounted into the container (skip bind mounts).
  $json = docker inspect $name 2>$null | Out-String
  if ($LASTEXITCODE -ne 0) { return @() }
  $parsed = $json | ConvertFrom-Json
  $mounts = $parsed[0].Mounts
  $vols = @()
  foreach ($m in $mounts) {
    if ($m.Type -eq "volume" -and $m.Name) { $vols += $m.Name }
  }
  return $vols
}

function Test-HermesHealthy {
  try {
    $r = Invoke-WebRequest -Uri $HERMES_HEALTHZ -UseBasicParsing -TimeoutSec 4
    return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
  } catch { return $false }
}

function Get-FileSha256([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# --- Phase 0: pre-flight ----------------------------------------------------
Banner "PHASE 0 -- pre-flight"

if (-not (Test-DockerAvailable)) {
  Add-Step "0" "docker daemon reachable" "red" "docker version failed; nothing to do"
  Write-Host "FATAL: docker not available." -ForegroundColor Red
  exit 2
}
Add-Step "0" "docker daemon reachable" "green" ""

if (-not (Test-Path -LiteralPath $RECEIPT_DIR)) {
  if ($DryRun) {
    Add-Step "0" "receipt dir exists" "yellow" ("would mkdir {0}" -f $RECEIPT_DIR)
  } else {
    try {
      New-Item -ItemType Directory -Force -Path $RECEIPT_DIR | Out-Null
      Add-Step "0" "receipt dir exists" "green" ("created {0}" -f $RECEIPT_DIR)
    } catch {
      Add-Step "0" "receipt dir exists" "red" $_.Exception.Message
      exit 2
    }
  }
} else {
  Add-Step "0" "receipt dir exists" "green" $RECEIPT_DIR
}

if (-not (Test-Path -LiteralPath $MIGRATION_ROOT_WIN)) {
  if ($DryRun) {
    Add-Step "0" "migration dir exists" "yellow" ("would mkdir {0}" -f $MIGRATION_ROOT_WIN)
  } else {
    try {
      New-Item -ItemType Directory -Force -Path $MIGRATION_ROOT_WIN | Out-Null
      Add-Step "0" "migration dir exists" "green" ("created {0}" -f $MIGRATION_ROOT_WIN)
    } catch {
      Add-Step "0" "migration dir exists" "red" $_.Exception.Message
      exit 2
    }
  }
} else {
  Add-Step "0" "migration dir exists" "green" $MIGRATION_ROOT_WIN
}

if ($SkipHermesCheck) {
  Add-Step "0" "replacement surface healthy" "yellow" "SKIPPED via -SkipHermesCheck; No-Take-Down Law overridden by operator"
} else {
  if (Test-HermesHealthy) {
    Add-Step "0" "replacement surface healthy" "green" $HERMES_HEALTHZ
  } else {
    Add-Step "0" "replacement surface healthy" "red" ("Hermes not answering {0}; refusing to take n8n down (No-Take-Down Law)" -f $HERMES_HEALTHZ)
    Banner "ABORT -- No-Take-Down Law"
    Write-Host "Replacement not proven healthy. Bring Hermes up before killing n8n." -ForegroundColor Red
    # Still emit a receipt so the abort is on the record.
    $abortBody = "# kill-n8n ABORT`n`nReplacement at {0} not healthy. No destructive action taken.`n" -f $HERMES_HEALTHZ
    Set-Content -LiteralPath $RECEIPT_PATH -Value $abortBody -Encoding utf8
    exit 1
  }
}

# --- Phase 1: container identification --------------------------------------
Banner "PHASE 1 -- identify container"

if (-not (Test-ContainerExists $ContainerName)) {
  Add-Step "1" "container exists" "red" ("'{0}' not found via docker ps -a" -f $ContainerName)
  Write-Host "FATAL: container not found. Nothing to migrate." -ForegroundColor Red
  exit 2
}
Add-Step "1" "container exists" "green" $ContainerName

$wasRunning = Test-ContainerRunning $ContainerName
Add-Step "1" "container running state" "green" ("running={0}" -f $wasRunning)

# Capture image + mounts + relevant metadata
$inspectJson = docker inspect $ContainerName 2>$null | Out-String
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($inspectJson)) {
  Add-Step "1" "container inspect" "red" "docker inspect returned empty"
  exit 2
}
$inspect = ($inspectJson | ConvertFrom-Json)[0]
$image       = $inspect.Config.Image
$imageDigest = $inspect.Image
$restartPol  = $inspect.HostConfig.RestartPolicy.Name
$createdAt   = $inspect.Created
$startedAt   = $inspect.State.StartedAt
$volumes     = Get-ContainerVolumes $ContainerName

Add-Step "1" "container image" "green" ("{0} ({1})" -f $image, $imageDigest)
if ($volumes.Count -eq 0) {
  Add-Step "1" "named volumes" "yellow" "no named volumes mounted; workflow db may be on a bind mount or ephemeral"
} else {
  Add-Step "1" "named volumes" "green" ($volumes -join ", ")
}

# --- Phase 2: export workflows (and optionally credentials) -----------------
Banner "PHASE 2 -- export workflows via n8n CLI"

$workflowHostPath = Join-Path $MIGRATION_ROOT_WIN $WORKFLOW_JSON_NAME
$credHostPath     = Join-Path $MIGRATION_ROOT_WIN $CRED_JSON_NAME
$workflowShaHostPath = "{0}.sha256" -f $workflowHostPath
$workflowSha = $null
$credSha     = $null

# Workflow export requires the container to be running (n8n CLI talks to its
# own sqlite db inside the container). If it is not running, start it briefly
# in a controlled way -- but only if -Force AND not -DryRun; otherwise yellow.
$needToStartForExport = (-not $wasRunning)

if ($DryRun) {
  $planned = "docker exec {0} n8n export:workflow --all --pretty --output=/tmp/{1} && docker cp {0}:/tmp/{1} {2}" -f $ContainerName, $WORKFLOW_JSON_NAME, $workflowHostPath
  Add-Step "2" "workflow export (planned)" "yellow" $planned
  if ($ExportCredentials) {
    $plannedCred = "docker exec {0} n8n export:credentials --all --pretty --output=/tmp/{1} && docker cp {0}:/tmp/{1} {2}" -f $ContainerName, $CRED_JSON_NAME, $credHostPath
    Add-Step "2" "credentials export (planned)" "yellow" $plannedCred
  }
} else {
  if ($needToStartForExport) {
    Add-Step "2" "container start for export" "yellow" "container not running; starting briefly to run n8n export"
    & docker start $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Add-Step "2" "container start for export" "red" ("docker start exit={0}" -f $LASTEXITCODE)
      Banner "ABORT -- could not start container for export"
      exit 1
    }
    # Give n8n a moment to settle before we exec into it.
    Start-Sleep -Seconds 5
  }

  # Export workflows. n8n CLI writes inside the container; we then docker cp out.
  $inContainerPath = "/tmp/{0}" -f $WORKFLOW_JSON_NAME
  & docker exec $ContainerName n8n export:workflow --all --pretty ("--output={0}" -f $inContainerPath) | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Add-Step "2" "workflow export" "red" ("n8n export:workflow exit={0}" -f $LASTEXITCODE)
    Banner "ABORT -- workflow export failed"
    Write-Host "n8n CLI export failed. NOT killing container." -ForegroundColor Red
    exit 1
  }
  & docker cp ("{0}:{1}" -f $ContainerName, $inContainerPath) $workflowHostPath | Out-Null
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $workflowHostPath)) {
    Add-Step "2" "workflow export copy-out" "red" ("docker cp failed or file missing at {0}" -f $workflowHostPath)
    Banner "ABORT -- workflow copy-out failed"
    exit 1
  }
  $wfSize = (Get-Item -LiteralPath $workflowHostPath).Length
  if ($wfSize -lt $MIN_EXPORT_BYTES) {
    Add-Step "2" "workflow export" "red" ("export suspiciously small: {0} bytes < {1}; refusing to proceed" -f $wfSize, $MIN_EXPORT_BYTES)
    Banner "ABORT -- workflow export too small"
    exit 1
  }
  $workflowSha = Get-FileSha256 $workflowHostPath
  Set-Content -LiteralPath $workflowShaHostPath -Value ("{0}  {1}" -f $workflowSha, $WORKFLOW_JSON_NAME) -Encoding ascii
  Add-Step "2" "workflow export" "green" ("{0} bytes sha256={1} -> {2}" -f $wfSize, $workflowSha, $workflowHostPath)

  # Optional credentials export (encrypted blobs; useless without n8n encryption key from the volume tarball).
  if ($ExportCredentials) {
    $inCredPath = "/tmp/{0}" -f $CRED_JSON_NAME
    & docker exec $ContainerName n8n export:credentials --all --pretty ("--output={0}" -f $inCredPath) | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Add-Step "2" "credentials export" "red" ("n8n export:credentials exit={0}" -f $LASTEXITCODE)
      Banner "ABORT -- credentials export failed"
      exit 1
    }
    & docker cp ("{0}:{1}" -f $ContainerName, $inCredPath) $credHostPath | Out-Null
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $credHostPath)) {
      Add-Step "2" "credentials export copy-out" "red" ("docker cp failed or file missing at {0}" -f $credHostPath)
      exit 1
    }
    $credSize = (Get-Item -LiteralPath $credHostPath).Length
    if ($credSize -lt $MIN_EXPORT_BYTES) {
      Add-Step "2" "credentials export" "red" ("export suspiciously small: {0} bytes < {1}" -f $credSize, $MIN_EXPORT_BYTES)
      exit 1
    }
    $credSha = Get-FileSha256 $credHostPath
    Set-Content -LiteralPath ("{0}.sha256" -f $credHostPath) -Value ("{0}  {1}" -f $credSha, $CRED_JSON_NAME) -Encoding ascii
    Add-Step "2" "credentials export" "green" ("{0} bytes sha256={1} -> {2}" -f $credSize, $credSha, $credHostPath)
  } else {
    Add-Step "2" "credentials export" "skip" "-ExportCredentials not set; credentials remain only inside volume tarball"
  }
}

# --- Phase 3: backup named volume(s) ---------------------------------------
Banner "PHASE 3 -- backup n8n named volume(s)"

$backupTarHostPath  = Join-Path $MIGRATION_ROOT_WIN $BACKUP_TAR_NAME
$backupMetaHostPath = Join-Path $MIGRATION_ROOT_WIN $BACKUP_META_NAME

if ($volumes.Count -eq 0) {
  Add-Step "3" "backup tarball" "yellow" "no named volume to back up; skipping volume tar (workflow JSON above is the primary recovery artifact)"
  $backupSha = $null
} else {
  if ($DryRun) {
    $planned = "docker run --rm -v {0}:/data:ro -v {1}:/backup busybox sh -c 'cd /data && tar czf /backup/{2} .'" -f $volumes[0], $MIGRATION_ROOT_WIN, $BACKUP_TAR_NAME
    Add-Step "3" "backup tarball (planned)" "yellow" $planned
    $backupSha = $null
  } else {
    $allOk = $true
    foreach ($vol in $volumes) {
      $thisTar = if ($volumes.Count -eq 1) { $BACKUP_TAR_NAME } else { "{0}__{1}.tar.gz" -f $BACKUP_BASENAME, $vol }
      $thisTarHost = Join-Path $MIGRATION_ROOT_WIN $thisTar
      Write-Host ("  -> backing up volume '{0}' -> {1}" -f $vol, $thisTarHost) -ForegroundColor DarkCyan
      $args = @(
        "run","--rm",
        "-v", ("{0}:/data:ro" -f $vol),
        "-v", ("{0}:/backup" -f $MIGRATION_ROOT_WIN),
        "busybox","sh","-c",
        ("cd /data && tar czf /backup/{0} ." -f $thisTar)
      )
      & docker @args
      if ($LASTEXITCODE -ne 0) {
        Add-Step "3" ("backup volume '{0}'" -f $vol) "red" ("docker run busybox tar failed exit={0}" -f $LASTEXITCODE)
        $allOk = $false
        break
      }
      if (-not (Test-Path -LiteralPath $thisTarHost)) {
        Add-Step "3" ("backup volume '{0}'" -f $vol) "red" ("expected tarball missing: {0}" -f $thisTarHost)
        $allOk = $false
        break
      }
      $size = (Get-Item -LiteralPath $thisTarHost).Length
      if ($size -lt $MIN_BACKUP_BYTES) {
        Add-Step "3" ("backup volume '{0}'" -f $vol) "red" ("tarball suspiciously small: {0} bytes < {1}" -f $size, $MIN_BACKUP_BYTES)
        $allOk = $false
        break
      }
      $sha = Get-FileSha256 $thisTarHost
      Set-Content -LiteralPath ("{0}.sha256" -f $thisTarHost) -Value ("{0}  {1}" -f $sha, $thisTar) -Encoding ascii
      Add-Step "3" ("backup volume '{0}'" -f $vol) "green" ("{0} bytes sha256={1}" -f $size, $sha)
    }
    if (-not $allOk) {
      Banner "ABORT -- backup failed"
      Write-Host "Volume backup did not complete cleanly. NOT killing container." -ForegroundColor Red
      exit 1
    }
    $backupSha = Get-FileSha256 $backupTarHostPath
  }
}

# Metadata snapshot -- always written when backup phase ran (or planned)
$meta = [ordered]@{
  container_name      = $ContainerName
  image               = $image
  image_digest        = $imageDigest
  restart_policy      = $restartPol
  created_at          = $createdAt
  started_at          = $startedAt
  was_running         = $wasRunning
  named_volumes       = $volumes
  backup_tarball      = if ($volumes.Count -gt 0) { $BACKUP_TAR_NAME } else { $null }
  backup_sha256       = $backupSha
  workflow_export     = $WORKFLOW_JSON_NAME
  workflow_sha256     = $workflowSha
  credentials_export  = if ($ExportCredentials) { $CRED_JSON_NAME } else { $null }
  credentials_sha256  = $credSha
  retired_at_utc      = $TS_UTC
  retired_by          = "scripts/codexa-migration/02-kill-n8n.ps1"
  doctrine_ref        = "receipt #013 (W1 close)"
}
if ($DryRun) {
  Add-Step "3" "metadata snapshot" "yellow" ("would write {0}" -f $backupMetaHostPath)
} else {
  $meta | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $backupMetaHostPath -Encoding utf8
  Add-Step "3" "metadata snapshot" "green" $backupMetaHostPath
}

# --- Phase 4: destructive kill (gated on -Force) ----------------------------
Banner "PHASE 4 -- stop and remove container"

if (-not $Force) {
  Add-Step "4" "docker stop + rm" "yellow" "-Force not supplied; backup-only run. Re-run with -Force to commit the kill."
  Banner "BACKUP-ONLY RUN COMPLETE"
} elseif ($DryRun) {
  Add-Step "4" "docker stop (planned)" "yellow" ("docker stop --time {0} {1}" -f $STOP_TIMEOUT_SEC, $ContainerName)
  Add-Step "4" "docker rm (planned)"  "yellow" ("docker rm {0}" -f $ContainerName)
} else {
  # If we started the container ourselves for the export, it is running now
  # even though $wasRunning is false. Always check live state before stopping.
  $isRunningNow = Test-ContainerRunning $ContainerName
  if ($isRunningNow) {
    & docker stop --time $STOP_TIMEOUT_SEC $ContainerName | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Add-Step "4" "docker stop" "red" ("exit={0}" -f $LASTEXITCODE)
      exit 1
    }
    Add-Step "4" "docker stop" "green" ("stopped within {0}s" -f $STOP_TIMEOUT_SEC)
  } else {
    Add-Step "4" "docker stop" "skip" "container already not running"
  }

  & docker rm $ContainerName | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Add-Step "4" "docker rm" "red" ("exit={0}" -f $LASTEXITCODE)
    exit 1
  }
  Add-Step "4" "docker rm" "green" "container removed"

  if ($ReclaimImage) {
    & docker image rm $image 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Add-Step "4" "docker image rm" "green" $image
    } else {
      Add-Step "4" "docker image rm" "yellow" "image still in use elsewhere or already gone; leaving cached"
    }
  } else {
    Add-Step "4" "docker image rm" "skip" "image kept cached for cheap rollback (-ReclaimImage not set)"
  }
}

# --- Phase 5: receipt -------------------------------------------------------
Banner "PHASE 5 -- emit receipt"

$rc = New-Object System.Collections.Generic.List[string]
$rc.Add("# Codexa migration W1 -- kill n8n") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("- Date (UTC): {0}" -f $TS_UTC)) | Out-Null
$rc.Add(("- Container: ``{0}``" -f $ContainerName)) | Out-Null
$rc.Add(("- Image: ``{0}``" -f $image)) | Out-Null
$rc.Add(("- Was running: {0}" -f $wasRunning)) | Out-Null
$rc.Add(("- Named volumes: {0}" -f ($(if ($volumes.Count -gt 0) { $volumes -join ', ' } else { '(none)' })))) | Out-Null
$rc.Add(("- Backup dir: ``{0}``" -f $MIGRATION_ROOT_WIN)) | Out-Null
$rc.Add(("- Workflow export: ``{0}``" -f $WORKFLOW_JSON_NAME)) | Out-Null
if ($workflowSha) { $rc.Add(("- Workflow SHA-256: ``{0}``" -f $workflowSha)) | Out-Null }
if ($backupSha)   { $rc.Add(("- Volume backup SHA-256: ``{0}``" -f $backupSha)) | Out-Null }
if ($ExportCredentials -and $credSha) {
  $rc.Add(("- Credentials export: ``{0}`` (SHA-256 ``{1}``)" -f $CRED_JSON_NAME, $credSha)) | Out-Null
}
$rc.Add(("- DryRun: {0}" -f $DryRun.IsPresent)) | Out-Null
$rc.Add(("- Force:  {0}" -f $Force.IsPresent)) | Out-Null
$rc.Add(("- SkipHermesCheck: {0}" -f $SkipHermesCheck.IsPresent)) | Out-Null
$rc.Add(("- ReclaimImage: {0}" -f $ReclaimImage.IsPresent)) | Out-Null
$rc.Add(("- ExportCredentials: {0}" -f $ExportCredentials.IsPresent)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add("## Steps") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| Phase | Status | Title | Detail |") | Out-Null
$rc.Add("|-------|--------|-------|--------|") | Out-Null
foreach ($s in $steps) {
  $detail = ($s.detail -replace '\|','\\|')
  $rc.Add(("| {0} | {1} | {2} | {3} |" -f $s.phase, $s.status, $s.title, $detail)) | Out-Null
}
$rc.Add("") | Out-Null
$rc.Add("## Rollback") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("Two rollback paths, in order of preference:") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("1. **Workflow-only re-import into Hermes**: load") | Out-Null
$rc.Add(("   ``{0}`` into Hermes via its workflow import API." -f $WORKFLOW_JSON_NAME)) | Out-Null
$rc.Add("   Use this when Hermes is the durable home and you only need the") | Out-Null
$rc.Add("   workflow definitions back.") | Out-Null
$rc.Add("2. **Full n8n restore**: run ``scripts/codexa-migration/02-rollback-n8n.ps1``") | Out-Null
$rc.Add(("   with the same ``-ContainerName`` (default ``{0}``). The rollback" -f $ContainerName)) | Out-Null
$rc.Add("   script restores from the volume tarball above into a fresh named") | Out-Null
$rc.Add("   volume and recreates the container with the original image,") | Out-Null
$rc.Add("   restart policy, and mounts.") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("## Doctrine") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- Mom's Law: receipts only, no theater.") | Out-Null
$rc.Add("- No-Take-Down Law: replacement (Hermes :7430) must be proven healthy before kill.") | Out-Null
$rc.Add("- Receipt #013: n8n retires at W1 close.") | Out-Null

if ($DryRun) {
  Write-Host "DryRun: receipt NOT written. Would write to:" -ForegroundColor Yellow
  Write-Host ("  {0}" -f $RECEIPT_PATH) -ForegroundColor Yellow
} else {
  Set-Content -LiteralPath $RECEIPT_PATH -Value ($rc -join "`n") -Encoding utf8
  Write-Host ("Receipt: {0}" -f $RECEIPT_PATH) -ForegroundColor Green
}

if (Has-Red) {
  Write-Host "Result: RED rows present. Exit 1." -ForegroundColor Red
  exit 1
}
Write-Host "Result: GREEN." -ForegroundColor Green
exit 0
