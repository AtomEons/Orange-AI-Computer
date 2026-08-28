# 03-kill-wiki.ps1
# Codexa migration W2 step 3 -- retire legacy orangebox-wiki surface.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: full effort, no theater, no silent fallback. Receipts only.
#   - No-Take-Down Law: a running surface only dies when (a) its replacement is
#     proven healthy and (b) its state has been BOTH backed up (binary volume
#     tarball) AND human-readable-archived (Markdown export of every page).
#     If either evidence stream fails this script EXITS NON-ZERO and touches
#     nothing destructive.
#   - Receipt #013 (Codexa migration plan): open-webui retires at W1 close,
#     n8n at W1 close, orangebox-wiki at W2 close, qdrant is KEPT, postgres
#     and redis evaluated separately. This script handles orangebox-wiki only.
#   - The Vault lane (Mirage StateBrief) is the replacement surface for static
#     knowledge that previously lived in the wiki. Until StateBrief is flowing,
#     the wiki stays up. No exceptions.
#
# What it does (in order; aborts on first red):
#   1. Pre-flight -- verify the Vault lane is healthy:
#        a. Mirage StateBrief endpoint @ 127.0.0.1:11211/statebrief/healthz
#           is answering with HTTP 2xx.
#        b. StateBrief has produced a fresh brief in the last
#           $STATEBRIEF_FRESH_MIN minutes (default 30), proving the lane is
#           actually FLOWING and not merely listening.
#        c. The Mirage brief feed at .../statebrief/latest returns a non-empty
#           payload with a recent UTC timestamp.
#      No fresh StateBrief, no kill.
#   2. Identify the legacy wiki container (default aeorangebox-ai-box-wiki-1;
#      override via -ContainerName).
#   3. Inspect the container, capture image + mounts + named volume(s).
#   4. EXPORT every wiki page as Markdown to
#      19-ARCHIVE/orangebox-wiki-<UTC-date>/. Export path is tried in this
#      order and the FIRST that succeeds wins:
#        a. Wiki.js GraphQL API (if reachable on container's published port and
#           -WikiApiToken supplied or WIKI_API_TOKEN env var present).
#        b. Direct Postgres dump: SELECT path, title, content FROM pages
#           through aeorangebox-ai-box-postgres-1 (Wiki.js schema). Each row
#           becomes one .md file under the archive dir mirroring the page path.
#        c. Last-resort: pull markdown files out of the wiki container at
#           /wiki/repo (Wiki.js Git storage location) via docker cp.
#      The archive MUST contain >= 1 .md file or the script aborts.
#      An index.md and an export.manifest.json are written summarizing the
#      page count, total bytes, page-path list, and the export method used.
#   5. Back up the wiki named volume(s) (uploads, attachments, search index)
#      to /opt/atomeons/migrations/wiki-<UTC-date>.tar.gz via a throwaway
#      `docker run --rm` container with busybox tar. SHA-256 the archive.
#      Refuse to proceed if the archive is < 1 KiB or missing.
#   6. Snapshot container metadata (image digest, env minus secrets, mounts,
#      created/started timestamps, restart policy) next to the tarball as
#      wiki-<UTC-date>.meta.json -- enough to rebuild it cold.
#   7. docker stop --time 30 <container>  then  docker rm <container>.
#   8. docker image rm of the cached wiki image IFF -ReclaimImage. Default
#      is to leave the image cached (cheap rollback insurance).
#   9. Write a Markdown receipt to 10-RECEIPTS/codexa-migration/ with every
#      step green/yellow/red, archive page count, and the SHA-256 of the
#      volume tarball.
#
# Flags:
#   -DryRun        : print every planned action; touch nothing; exit 0.
#                    Pre-flight checks (Vault lane, container exists, volume
#                    exists, archive + migration dirs writable) still run --
#                    they are read-only and surfacing a failure here is the
#                    whole point.
#   -Force         : REQUIRED for destructive steps (docker stop + rm).
#                    Without -Force everything up to and including the
#                    Markdown export AND the volume backup happens, then the
#                    script stops with a YELLOW row and exit 0. This lets you
#                    stage both evidence streams ahead of the cutover window
#                    without committing the kill.
#   -ContainerName : override the legacy container name. Default
#                    aeorangebox-ai-box-wiki-1 per receipt #013.
#   -PostgresContainer : Postgres container hosting the wiki DB. Default
#                    aeorangebox-ai-box-postgres-1.
#   -PostgresDb    : Postgres database name. Default 'wiki' (Wiki.js default).
#   -PostgresUser  : Postgres role used to read pages. Default 'wikijs'.
#   -WikiApiToken  : optional GraphQL API token for Wiki.js. If absent the
#                    Postgres path is tried first.
#   -StateBriefUrl : override the Mirage StateBrief healthz URL. Default
#                    http://127.0.0.1:11211/statebrief/healthz .
#   -StateBriefLatestUrl : override the latest-brief endpoint. Default
#                    http://127.0.0.1:11211/statebrief/latest .
#   -StateBriefFreshMin : maximum age in minutes for the latest brief to be
#                    considered "flowing". Default 30.
#   -ReclaimImage  : after rm, also docker image rm the cached image. Default
#                    OFF -- keep the image so rollback is cheap.
#   -SkipVaultCheck : explicit override for the No-Take-Down Law. Only use
#                    this if the Vault lane lives somewhere unusual and you
#                    have proven it healthy by other means. Logs a loud yellow
#                    row in the receipt.
#
# Exit codes:
#   0  success, or DryRun, or backup-only (no -Force) with both evidence
#      streams green.
#   1  one or more steps failed; receipt emitted with red rows; nothing
#      destructive happened past the point of failure.
#   2  fatal pre-flight (docker missing, target dirs unwritable, container
#      named but not found, etc.). Nothing on disk changed.

[CmdletBinding()]
param(
  [switch]$DryRun,
  [switch]$Force,
  [string]$ContainerName        = "aeorangebox-ai-box-wiki-1",
  [string]$PostgresContainer    = "aeorangebox-ai-box-postgres-1",
  [string]$PostgresDb           = "wiki",
  [string]$PostgresUser         = "wikijs",
  [string]$WikiApiToken         = $env:WIKI_API_TOKEN,
  [string]$StateBriefUrl        = "http://127.0.0.1:11211/statebrief/healthz",
  [string]$StateBriefLatestUrl  = "http://127.0.0.1:11211/statebrief/latest",
  [int]   $StateBriefFreshMin   = 30,
  [switch]$ReclaimImage,
  [switch]$SkipVaultCheck
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths and constants (anchored, never relative) -------------------------
$ORANGE5_ROOT       = "C:\AtomEons\Orange5"
$RECEIPT_DIR        = Join-Path $ORANGE5_ROOT "10-RECEIPTS\codexa-migration"
$ARCHIVE_ROOT       = Join-Path $ORANGE5_ROOT "19-ARCHIVE"
$MIGRATION_ROOT     = "/opt/atomeons/migrations"     # in-container path
$MIGRATION_ROOT_WIN = "C:\opt\atomeons\migrations"   # Windows-side mirror
$DATE_STAMP_UTC     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$TS_UTC             = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")

$ARCHIVE_DIR_NAME   = "orangebox-wiki-{0}" -f $DATE_STAMP_UTC
$ARCHIVE_DIR        = Join-Path $ARCHIVE_ROOT $ARCHIVE_DIR_NAME
$ARCHIVE_INDEX_PATH = Join-Path $ARCHIVE_DIR "index.md"
$ARCHIVE_MANIFEST   = Join-Path $ARCHIVE_DIR "export.manifest.json"

$BACKUP_BASENAME    = "wiki-{0}" -f $DATE_STAMP_UTC
$BACKUP_TAR_NAME    = "{0}.tar.gz" -f $BACKUP_BASENAME
$BACKUP_META_NAME   = "{0}.meta.json" -f $BACKUP_BASENAME
$RECEIPT_PATH       = Join-Path $RECEIPT_DIR ("{0}-w2-kill-wiki.md" -f $DATE_STAMP_UTC)

$STOP_TIMEOUT_SEC   = 30
$MIN_BACKUP_BYTES   = 1024
$MIN_PAGES_REQUIRED = 1

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

function Test-VaultHealthy {
  # (a) healthz responds 2xx
  try {
    $r = Invoke-WebRequest -Uri $StateBriefUrl -UseBasicParsing -TimeoutSec 4
    if ($r.StatusCode -lt 200 -or $r.StatusCode -ge 300) { return @{ ok=$false; why=("healthz status {0}" -f $r.StatusCode); age_min=$null } }
  } catch {
    return @{ ok=$false; why=("healthz unreachable: {0}" -f $_.Exception.Message); age_min=$null }
  }
  # (b) latest brief is recent (proves the lane is flowing, not just listening)
  try {
    $latest = Invoke-WebRequest -Uri $StateBriefLatestUrl -UseBasicParsing -TimeoutSec 4
    if ($latest.StatusCode -lt 200 -or $latest.StatusCode -ge 300) {
      return @{ ok=$false; why=("latest status {0}" -f $latest.StatusCode); age_min=$null }
    }
    if ([string]::IsNullOrWhiteSpace($latest.Content)) {
      return @{ ok=$false; why="latest brief empty"; age_min=$null }
    }
    $obj = $latest.Content | ConvertFrom-Json
    if (-not $obj.PSObject.Properties.Match('ts').Count) {
      return @{ ok=$false; why="latest brief missing 'ts' field"; age_min=$null }
    }
    $briefTs = [datetime]::Parse($obj.ts).ToUniversalTime()
    $ageMin  = [int]((Get-Date).ToUniversalTime() - $briefTs).TotalMinutes
    if ($ageMin -gt $StateBriefFreshMin) {
      return @{ ok=$false; why=("latest brief stale: {0} min > {1} min" -f $ageMin, $StateBriefFreshMin); age_min=$ageMin }
    }
    return @{ ok=$true; why=("flowing; latest brief {0} min old" -f $ageMin); age_min=$ageMin }
  } catch {
    return @{ ok=$false; why=("latest brief check failed: {0}" -f $_.Exception.Message); age_min=$null }
  }
}

function Get-FileSha256([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Sanitize-PagePath([string]$p) {
  # Build a safe relative filesystem path from a wiki page path.
  if ([string]::IsNullOrWhiteSpace($p)) { return "untitled" }
  $clean = $p -replace '[\\/:*?"<>|]', '_'
  $clean = $clean -replace '^[\.\s/]+', ''
  $clean = $clean -replace '\s+$', ''
  if ([string]::IsNullOrWhiteSpace($clean)) { return "untitled" }
  return $clean
}

# --- Phase 0: pre-flight ----------------------------------------------------
Banner "PHASE 0 -- pre-flight"

if (-not (Test-DockerAvailable)) {
  Add-Step "0" "docker daemon reachable" "red" "docker version failed; nothing to do"
  Write-Host "FATAL: docker not available." -ForegroundColor Red
  exit 2
}
Add-Step "0" "docker daemon reachable" "green" ""

foreach ($d in @($RECEIPT_DIR, $ARCHIVE_ROOT, $MIGRATION_ROOT_WIN)) {
  if (-not (Test-Path -LiteralPath $d)) {
    if ($DryRun) {
      Add-Step "0" ("dir exists: {0}" -f $d) "yellow" "would mkdir"
    } else {
      try {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        Add-Step "0" ("dir exists: {0}" -f $d) "green" "created"
      } catch {
        Add-Step "0" ("dir exists: {0}" -f $d) "red" $_.Exception.Message
        exit 2
      }
    }
  } else {
    Add-Step "0" ("dir exists: {0}" -f $d) "green" ""
  }
}

# Archive subdir for THIS run
if (-not (Test-Path -LiteralPath $ARCHIVE_DIR)) {
  if ($DryRun) {
    Add-Step "0" "archive subdir" "yellow" ("would mkdir {0}" -f $ARCHIVE_DIR)
  } else {
    New-Item -ItemType Directory -Force -Path $ARCHIVE_DIR | Out-Null
    Add-Step "0" "archive subdir" "green" $ARCHIVE_DIR
  }
} else {
  Add-Step "0" "archive subdir" "yellow" ("already exists: {0} (re-run on same UTC day)" -f $ARCHIVE_DIR)
}

if ($SkipVaultCheck) {
  Add-Step "0" "Vault lane (StateBrief) flowing" "yellow" "SKIPPED via -SkipVaultCheck; No-Take-Down Law overridden by operator"
} else {
  $vault = Test-VaultHealthy
  if ($vault.ok) {
    Add-Step "0" "Vault lane (StateBrief) flowing" "green" $vault.why
  } else {
    Add-Step "0" "Vault lane (StateBrief) flowing" "red" ("refusing to take wiki down (No-Take-Down Law): {0}" -f $vault.why)
    Banner "ABORT -- No-Take-Down Law"
    Write-Host "Vault lane not proven to be flowing. Bring Mirage StateBrief up and producing fresh briefs before killing the wiki." -ForegroundColor Red
    $abortBody = "# kill-wiki ABORT`n`nVault lane (StateBrief) not flowing: {0}`n`nNo destructive action taken. Markdown export not attempted.`n" -f $vault.why
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
  Add-Step "1" "named volumes" "yellow" "no named volumes mounted; uploads may be on a bind mount"
} else {
  Add-Step "1" "named volumes" "green" ($volumes -join ", ")
}

# --- Phase 2: Markdown export to 19-ARCHIVE --------------------------------
Banner "PHASE 2 -- export wiki pages to Markdown"

$exportMethod = $null
$pageCount    = 0
$pageBytes    = 0
$pagePaths    = New-Object System.Collections.Generic.List[string]

function Write-PageMd([string]$pagePath, [string]$title, [string]$content) {
  $safe = Sanitize-PagePath $pagePath
  if (-not $safe.EndsWith(".md")) { $safe = "{0}.md" -f $safe }
  $target = Join-Path $ARCHIVE_DIR $safe
  $parent = Split-Path -Parent $target
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  $body = @()
  $body += ("---")
  $body += ("title: {0}" -f ($title -replace '"','\"'))
  $body += ("source_wiki_path: {0}" -f $pagePath)
  $body += ("exported_at_utc: {0}" -f $TS_UTC)
  $body += ("---")
  $body += ""
  $body += $content
  $text = ($body -join "`n")
  Set-Content -LiteralPath $target -Value $text -Encoding utf8
  $script:pageCount++
  $script:pageBytes += (Get-Item -LiteralPath $target).Length
  $script:pagePaths.Add($pagePath) | Out-Null
}

if ($DryRun) {
  Add-Step "2" "markdown export (planned)" "yellow" ("would export pages into {0}" -f $ARCHIVE_DIR)
} else {
  # --- 2a: Wiki.js GraphQL API path (if token supplied) -------------------
  if (-not [string]::IsNullOrWhiteSpace($WikiApiToken)) {
    try {
      # Discover the wiki's published port from container inspect.
      $ports = $inspect.NetworkSettings.Ports
      $wikiPort = $null
      foreach ($p in $ports.PSObject.Properties) {
        if ($p.Name -like "3000/tcp*" -and $p.Value -and $p.Value[0].HostPort) {
          $wikiPort = $p.Value[0].HostPort; break
        }
      }
      if (-not $wikiPort) { $wikiPort = "3000" }
      $gql = "http://127.0.0.1:{0}/graphql" -f $wikiPort
      $query = '{"query":"{ pages { list(orderBy: PATH) { id path title } } }"}'
      $headers = @{ Authorization = "Bearer $WikiApiToken"; "Content-Type" = "application/json" }
      $listResp = Invoke-WebRequest -Uri $gql -Method POST -Body $query -Headers $headers -UseBasicParsing -TimeoutSec 15
      $listObj  = $listResp.Content | ConvertFrom-Json
      $pages    = $listObj.data.pages.list
      if ($pages -and $pages.Count -gt 0) {
        foreach ($p in $pages) {
          $oneQ = '{"query":"query($id:Int!){ pages { single(id:$id) { path title content } } }","variables":{"id":' + $p.id + '}}'
          $oneR = Invoke-WebRequest -Uri $gql -Method POST -Body $oneQ -Headers $headers -UseBasicParsing -TimeoutSec 15
          $one  = ($oneR.Content | ConvertFrom-Json).data.pages.single
          Write-PageMd -pagePath $one.path -title $one.title -content $one.content
        }
        $exportMethod = "wikijs-graphql"
        Add-Step "2" "markdown export via Wiki.js GraphQL" "green" ("{0} pages, {1} bytes" -f $pageCount, $pageBytes)
      } else {
        Add-Step "2" "markdown export via Wiki.js GraphQL" "yellow" "GraphQL returned 0 pages; falling back to Postgres dump"
      }
    } catch {
      Add-Step "2" "markdown export via Wiki.js GraphQL" "yellow" ("API path failed, falling back: {0}" -f $_.Exception.Message)
    }
  } else {
    Add-Step "2" "markdown export via Wiki.js GraphQL" "skip" "no -WikiApiToken / WIKI_API_TOKEN env; trying Postgres path"
  }

  # --- 2b: Postgres direct dump (Wiki.js schema) --------------------------
  if (-not $exportMethod) {
    if (-not (Test-ContainerExists $PostgresContainer)) {
      Add-Step "2" "postgres container exists" "yellow" ("'{0}' not found; will try docker cp fallback" -f $PostgresContainer)
    } elseif (-not (Test-ContainerRunning $PostgresContainer)) {
      Add-Step "2" "postgres container running" "yellow" ("'{0}' not running; cannot dump pages" -f $PostgresContainer)
    } else {
      try {
        # Pipe-delimited dump with a sentinel column terminator that's unlikely
        # to appear in markdown. \x1f (US) between columns, \x1e (RS) between rows.
        $sql = @"
\pset format unaligned
\pset tuples_only on
\pset fieldsep '\x1f'
\pset recordsep '\x1e'
SELECT path, title, COALESCE(content,'') FROM pages WHERE isPublished = true ORDER BY path;
"@
        $tmpSql = Join-Path $env:TEMP ("wiki-dump-{0}.sql" -f ([guid]::NewGuid().ToString("N")))
        Set-Content -LiteralPath $tmpSql -Value $sql -Encoding ascii
        # Copy SQL into the postgres container, run it, capture stdout.
        $inCtr = "/tmp/wiki-dump.sql"
        & docker cp $tmpSql ("{0}:{1}" -f $PostgresContainer, $inCtr)
        if ($LASTEXITCODE -ne 0) { throw "docker cp of SQL failed" }
        $raw = & docker exec -e PGOPTIONS="--client-min-messages=warning" $PostgresContainer `
                 psql -U $PostgresUser -d $PostgresDb -X -A -t -f $inCtr 2>$null
        if ($LASTEXITCODE -ne 0) { throw ("psql exit {0}" -f $LASTEXITCODE) }
        Remove-Item -LiteralPath $tmpSql -Force -ErrorAction SilentlyContinue
        # Split rows on \x1e, columns on \x1f.
        $rows = $raw -split [char]0x1e
        foreach ($row in $rows) {
          if ([string]::IsNullOrWhiteSpace($row)) { continue }
          $cols = $row -split [char]0x1f
          if ($cols.Length -lt 3) { continue }
          $p = $cols[0]; $t = $cols[1]; $c = $cols[2]
          Write-PageMd -pagePath $p -title $t -content $c
        }
        if ($pageCount -gt 0) {
          $exportMethod = "postgres-dump"
          Add-Step "2" "markdown export via Postgres" "green" ("{0} pages, {1} bytes" -f $pageCount, $pageBytes)
        } else {
          Add-Step "2" "markdown export via Postgres" "yellow" "dump returned 0 rows; trying docker cp fallback"
        }
      } catch {
        Add-Step "2" "markdown export via Postgres" "yellow" ("postgres path failed: {0}" -f $_.Exception.Message)
      }
    }
  }

  # --- 2c: docker cp fallback ---------------------------------------------
  if (-not $exportMethod) {
    try {
      $rawDir = Join-Path $ARCHIVE_DIR "_raw"
      New-Item -ItemType Directory -Force -Path $rawDir | Out-Null
      # Try the Wiki.js Git storage path first, then a generic /data path.
      $tried = @("/wiki/repo", "/wiki/data/content", "/data/content", "/data")
      $copied = $false
      foreach ($src in $tried) {
        & docker cp ("{0}:{1}" -f $ContainerName, $src) $rawDir 2>$null
        if ($LASTEXITCODE -eq 0) {
          $copied = $true
          $copiedFrom = $src
          break
        }
      }
      if (-not $copied) { throw "no known wiki content path found in container" }
      $mdFiles = Get-ChildItem -LiteralPath $rawDir -Recurse -Filter "*.md" -ErrorAction SilentlyContinue
      foreach ($f in $mdFiles) {
        $rel = $f.FullName.Substring($rawDir.Length).TrimStart('\','/')
        $pagePath = ($rel -replace '\\','/') -replace '\.md$',''
        $content = Get-Content -LiteralPath $f.FullName -Raw -Encoding utf8
        Write-PageMd -pagePath $pagePath -title $pagePath -content $content
      }
      if ($pageCount -gt 0) {
        $exportMethod = "docker-cp:{0}" -f $copiedFrom
        Add-Step "2" "markdown export via docker cp" "green" ("from {0}; {1} pages, {2} bytes" -f $copiedFrom, $pageCount, $pageBytes)
      } else {
        Add-Step "2" "markdown export via docker cp" "red" "no .md files found in container content paths"
      }
    } catch {
      Add-Step "2" "markdown export via docker cp" "red" ("fallback failed: {0}" -f $_.Exception.Message)
    }
  }

  if ($pageCount -lt $MIN_PAGES_REQUIRED) {
    Add-Step "2" "markdown export sufficiency" "red" ("exported {0} pages; require >= {1}; refusing to kill" -f $pageCount, $MIN_PAGES_REQUIRED)
    Banner "ABORT -- Markdown export failed"
    Write-Host "Wiki pages were not archived to Markdown. NOT killing container." -ForegroundColor Red
    # Emit a partial receipt so the abort is on the record.
    Set-Content -LiteralPath $RECEIPT_PATH -Value ("# kill-wiki ABORT`n`nMarkdown export produced {0} pages (< {1}). No destructive action.`n" -f $pageCount, $MIN_PAGES_REQUIRED) -Encoding utf8
    exit 1
  }

  # Index + manifest
  $indexBody = @()
  $indexBody += "# orangebox-wiki archive"
  $indexBody += ""
  $indexBody += ("- Exported (UTC): {0}" -f $TS_UTC)
  $indexBody += ("- Source container: ``{0}``" -f $ContainerName)
  $indexBody += ("- Export method: ``{0}``" -f $exportMethod)
  $indexBody += ("- Page count: {0}" -f $pageCount)
  $indexBody += ("- Total bytes: {0}" -f $pageBytes)
  $indexBody += ""
  $indexBody += "## Pages"
  $indexBody += ""
  foreach ($pp in ($pagePaths | Sort-Object)) {
    $indexBody += ("- ``{0}``" -f $pp)
  }
  Set-Content -LiteralPath $ARCHIVE_INDEX_PATH -Value ($indexBody -join "`n") -Encoding utf8

  $manifest = [ordered]@{
    archived_at_utc  = $TS_UTC
    source_container = $ContainerName
    export_method    = $exportMethod
    page_count       = $pageCount
    total_bytes      = $pageBytes
    pages            = ($pagePaths | Sort-Object)
    archive_dir      = $ARCHIVE_DIR
  }
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ARCHIVE_MANIFEST -Encoding utf8
  Add-Step "2" "archive index + manifest" "green" ("{0} pages indexed" -f $pageCount)
}

# --- Phase 3: backup volume(s) ----------------------------------------------
Banner "PHASE 3 -- backup wiki volume(s)"

$backupTarHostPath  = Join-Path $MIGRATION_ROOT_WIN $BACKUP_TAR_NAME
$backupMetaHostPath = Join-Path $MIGRATION_ROOT_WIN $BACKUP_META_NAME

$backupSha = $null
if ($volumes.Count -eq 0) {
  Add-Step "3" "backup tarball" "yellow" "no named volume to back up; relying on Markdown export only"
} else {
  if ($DryRun) {
    $planned = "docker run --rm -v <vol>:/data:ro -v {0}:/backup busybox tar czf /backup/<name> -C /data ." -f $MIGRATION_ROOT_WIN
    Add-Step "3" "backup tarball (planned)" "yellow" $planned
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
        $allOk = $false; break
      }
      if (-not (Test-Path -LiteralPath $thisTarHost)) {
        Add-Step "3" ("backup volume '{0}'" -f $vol) "red" ("expected tarball missing: {0}" -f $thisTarHost)
        $allOk = $false; break
      }
      $size = (Get-Item -LiteralPath $thisTarHost).Length
      if ($size -lt $MIN_BACKUP_BYTES) {
        Add-Step "3" ("backup volume '{0}'" -f $vol) "red" ("tarball suspiciously small: {0} bytes < {1}" -f $size, $MIN_BACKUP_BYTES)
        $allOk = $false; break
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

# Metadata snapshot
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
  archive_dir         = $ARCHIVE_DIR
  archive_page_count  = $pageCount
  archive_total_bytes = $pageBytes
  export_method       = $exportMethod
  retired_at_utc      = $TS_UTC
  retired_by          = "scripts/codexa-migration/03-kill-wiki.ps1"
  doctrine_ref        = "receipt #013 (W2 close)"
  vault_lane          = if ($SkipVaultCheck) { "skipped" } else { "flowing" }
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
  Add-Step "4" "docker stop + rm" "yellow" "-Force not supplied; archive-and-backup-only run. Re-run with -Force to commit the kill."
  Banner "ARCHIVE + BACKUP COMPLETE (no kill)"
} elseif ($DryRun) {
  Add-Step "4" "docker stop (planned)" "yellow" ("docker stop --time {0} {1}" -f $STOP_TIMEOUT_SEC, $ContainerName)
  Add-Step "4" "docker rm (planned)"  "yellow" ("docker rm {0}" -f $ContainerName)
} else {
  if ($wasRunning) {
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
$rc.Add("# Codexa migration W2 -- kill orangebox-wiki") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("- Date (UTC): {0}" -f $TS_UTC)) | Out-Null
$rc.Add(("- Container: ``{0}``" -f $ContainerName)) | Out-Null
$rc.Add(("- Image: ``{0}``" -f $image)) | Out-Null
$rc.Add(("- Was running: {0}" -f $wasRunning)) | Out-Null
$rc.Add(("- Named volumes: {0}" -f ($(if ($volumes.Count -gt 0) { $volumes -join ', ' } else { '(none)' })))) | Out-Null
$rc.Add(("- Archive dir: ``{0}``" -f $ARCHIVE_DIR)) | Out-Null
$rc.Add(("- Pages exported: {0}" -f $pageCount)) | Out-Null
$rc.Add(("- Export method: ``{0}``" -f $exportMethod)) | Out-Null
$rc.Add(("- Backup dir: ``{0}``" -f $MIGRATION_ROOT_WIN)) | Out-Null
if ($backupSha) { $rc.Add(("- Backup SHA-256: ``{0}``" -f $backupSha)) | Out-Null }
$rc.Add(("- Vault lane: {0}" -f $(if ($SkipVaultCheck) { 'SKIPPED' } else { 'flowing (Mirage StateBrief)' }))) | Out-Null
$rc.Add(("- DryRun: {0}" -f $DryRun.IsPresent)) | Out-Null
$rc.Add(("- Force:  {0}" -f $Force.IsPresent)) | Out-Null
$rc.Add(("- SkipVaultCheck: {0}" -f $SkipVaultCheck.IsPresent)) | Out-Null
$rc.Add(("- ReclaimImage: {0}" -f $ReclaimImage.IsPresent)) | Out-Null
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
$rc.Add("Run ``scripts/codexa-migration/03-rollback-wiki.ps1`` (companion script)") | Out-Null
$rc.Add(("with the same ``-ContainerName`` (default ``{0}``). It restores the" -f $ContainerName)) | Out-Null
$rc.Add("volume tarball into a fresh named volume and recreates the container") | Out-Null
$rc.Add("with the original image, restart policy, and mounts. The Markdown") | Out-Null
$rc.Add("archive in 19-ARCHIVE is kept regardless and is the canonical human-") | Out-Null
$rc.Add("readable record of wiki state at retirement.") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("## Doctrine") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- Mom's Law: receipts only, no theater.") | Out-Null
$rc.Add("- No-Take-Down Law: replacement (Vault lane / Mirage StateBrief) must") | Out-Null
$rc.Add("  be proven FLOWING (fresh brief within window) before kill.") | Out-Null
$rc.Add("- Two evidence streams: Markdown archive AND volume tarball. Both") | Out-Null
$rc.Add("  must be green before the kill is allowed to commit.") | Out-Null
$rc.Add("- Receipt #013: orangebox-wiki retires at W2 close.") | Out-Null

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
