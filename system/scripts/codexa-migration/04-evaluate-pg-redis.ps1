# 04-evaluate-pg-redis.ps1
# Codexa migration W2 step — evaluate whether the Mirage postgres and redis
# adapters are actually USED anywhere in Orange5 (DAGs, gateway, agents,
# command center, tests) or if those two legacy Codexa backends
# (aeorangebox-ai-box-postgres-1, aeorangebox-ai-box-redis-1) can be retired.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: full effort, no theater, receipts only. No silent fallback.
#   - No-Take-Down Law: this script is READ-ONLY. It NEVER stops, removes, or
#     mutates any container, volume, image, or process. It only INSPECTS the
#     codebase, the live containers, and ATOMEONS_PG_URL / REDIS_URL env to
#     answer one question per adapter:
#         "Does anything in Orange5 still depend on this backend?"
#     If the answer is NO -> the receipt marks the backend RETIRABLE and
#     proposes a scheduled retirement window (operator must run a separate
#     destructive script to actually kill it).
#     If the answer is YES -> the receipt marks the backend IN-USE, lists
#     every consumer found, and explicitly tells the operator NOT to retire.
#   - Receipt #013 (Codexa migration plan): kill open-webui at W1 close, n8n
#     at W1 close, orangebox-wiki at W2 close, KEEP qdrant, EVALUATE postgres
#     and redis (this script). No backend dies before evaluation says it's safe.
#
# What it does (in order; never aborts, always emits a receipt):
#   PHASE 0 — pre-flight (read-only):
#     - docker daemon reachable (informational only; missing docker just means
#       we cannot probe the live containers — code-side evidence still counts)
#     - target dirs exist (receipt dir, migration dir)
#   PHASE 1 — codebase scan (the load-bearing evidence):
#     - For postgres:
#         * import patterns: from './postgres.mjs', 11-MIRAGE/adapters/postgres,
#           getAdapter('postgres'), ATOMEONS_PG_URL, "mount":"postgres",
#           PG_URL, postgres://, "table":"postgres" hermes leases, etc.
#         * Exclude: the adapter file itself, the registry index that lists ALL
#           mounts, the SPEC.md, this script, and the migration script tree —
#           those references are descriptive, not consuming.
#     - For redis:
#         * import patterns: from './redis.mjs', 11-MIRAGE/adapters/redis,
#           getAdapter('redis'), REDIS_URL, redis://, ioredis, etc.
#         * Same exclusion list.
#     Each hit is captured (file, line, snippet). A hit count of 0 means the
#     adapter is wired but nothing consumes it -> RETIRABLE.
#   PHASE 2 — live container probe (if docker reachable):
#     - List the two legacy containers; capture state (running/stopped),
#       image, named volumes. Pure inspection. No stop/rm/restart.
#   PHASE 3 — env probe:
#     - Is ATOMEONS_PG_URL set? Is REDIS_URL set? Set + adapter unused is the
#       ambiguous case the operator must resolve (env is plumbed but nothing
#       calls the adapter; could be future use or stale config).
#   PHASE 4 — verdict + receipt:
#     For each of {postgres, redis} emit one of three verdicts:
#       RETIRABLE       : zero consumer hits, no ambiguous env signal, OR
#                         consumer hits exist only inside the migration tree
#                         and the adapter file itself.
#       IN-USE          : one or more consumer hits outside the exclusion list.
#       AMBIGUOUS       : zero consumer hits BUT env is set, suggesting the
#                         adapter is plumbed for a planned use. Operator
#                         decides; no retirement until ambiguity is resolved.
#     For RETIRABLE, the receipt also proposes a kill order skeleton:
#         "backup volume(s) -> verify replacement -> docker stop -> docker rm"
#     pointing at the existing 01-/02-/03- script pattern. Crucially, this
#     script does not WRITE that kill script — it only proposes it.
#
# Flags:
#   -OutputJson        : also write a sibling .json alongside the .md receipt
#                        for downstream tools (orange3 routes, command center).
#   -Strict            : treat AMBIGUOUS as IN-USE in the verdict. Useful for
#                        unattended cron evaluation where you want a "safe by
#                        default" answer.
#   -SkipContainers    : skip the live container probe (docker may be down or
#                        the operator only wants code-side evidence today).
#
# Exit codes:
#   0  evaluation completed; receipt emitted; nothing destructive occurred.
#      (Verdicts of any color still exit 0 — the receipt is the deliverable.)
#   2  fatal pre-flight (Orange5 root missing, receipt dir unwritable). Nothing
#      on disk changed.

[CmdletBinding()]
param(
  [switch]$OutputJson,
  [switch]$Strict,
  [switch]$SkipContainers
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths and constants (anchored, never relative) -------------------------
$ORANGE5_ROOT       = "C:\AtomEons\Orange5"
$RECEIPT_DIR        = Join-Path $ORANGE5_ROOT "10-RECEIPTS\codexa-migration"
$MIGRATION_ROOT_WIN = "C:\opt\atomeons\migrations"
$DATE_STAMP_UTC     = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$TS_UTC             = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$RECEIPT_PATH       = Join-Path $RECEIPT_DIR ("{0}-w2-evaluate-pg-redis.md" -f $DATE_STAMP_UTC)
$RECEIPT_JSON_PATH  = Join-Path $RECEIPT_DIR ("{0}-w2-evaluate-pg-redis.json" -f $DATE_STAMP_UTC)

$PG_CONTAINER       = "aeorangebox-ai-box-postgres-1"
$REDIS_CONTAINER    = "aeorangebox-ai-box-redis-1"

# Files whose mentions of postgres/redis are DESCRIPTIVE, not CONSUMING.
# A hit only here is not evidence of live use.
$EXCLUDE_GLOBS = @(
  "11-MIRAGE\adapters\postgres.mjs",
  "11-MIRAGE\adapters\redis.mjs",
  "11-MIRAGE\adapters\index.mjs",
  "11-MIRAGE\SPEC.md",
  "11-MIRAGE\tests\*",
  "scripts\codexa-migration\*",
  "10-RECEIPTS\codexa-migration\*",
  "10-RECEIPTS\orange5-build\*",
  "node_modules\*",
  ".git\*"
)

# Patterns that count as REAL consumption of the adapter (one match is enough).
$PG_PATTERNS = @(
  "from\s+['""].*adapters/postgres(\.mjs)?['""]",       # direct import
  "getAdapter\(\s*['""]postgres['""]\s*\)",              # registry resolution
  "ATOMEONS_PG_URL",                                     # env consumption
  "process\.env\.ATOMEONS_PG_URL"
)
$REDIS_PATTERNS = @(
  "from\s+['""].*adapters/redis(\.mjs)?['""]",
  "getAdapter\(\s*['""]redis['""]\s*\)",
  "REDIS_URL",
  "process\.env\.REDIS_URL",
  "import\s+.*\s+from\s+['""]ioredis['""]",
  "require\(\s*['""]ioredis['""]\s*\)"
)

# --- Step accumulator -------------------------------------------------------
$steps = New-Object System.Collections.Generic.List[object]
function Add-Step {
  param(
    [string]$Phase,
    [string]$Title,
    [ValidateSet("green","yellow","red","skip","info")][string]$Status,
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
    "info"   { "Cyan" }
  }
  Write-Host ("[{0}] {1} -- {2} :: {3}" -f $Phase, $Status.ToUpper(), $Title, $Detail) -ForegroundColor $color
}
function Banner([string]$msg) {
  Write-Host ""
  Write-Host ("===== {0} =====" -f $msg) -ForegroundColor Cyan
}

# --- Helpers ----------------------------------------------------------------
function Test-DockerAvailable {
  try { docker version --format '{{.Server.Version}}' 1>$null 2>$null } catch { return $false }
  return ($LASTEXITCODE -eq 0)
}

function Test-ContainerExists([string]$name) {
  if (-not (Test-DockerAvailable)) { return $false }
  $found = docker ps -a --filter ("name=^/{0}$" -f $name) --format '{{.Names}}' 2>$null
  return ($found -eq $name)
}

function Get-ContainerSnapshot([string]$name) {
  $snap = [ordered]@{
    name           = $name
    exists         = $false
    running        = $false
    image          = $null
    image_digest   = $null
    restart_policy = $null
    created_at     = $null
    started_at     = $null
    named_volumes  = @()
  }
  if (-not (Test-ContainerExists $name)) { return $snap }
  $snap.exists = $true
  try {
    $json = docker inspect $name 2>$null | Out-String
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($json)) { return $snap }
    $i = ($json | ConvertFrom-Json)[0]
    $snap.running        = ($i.State.Running -eq $true)
    $snap.image          = $i.Config.Image
    $snap.image_digest   = $i.Image
    $snap.restart_policy = $i.HostConfig.RestartPolicy.Name
    $snap.created_at     = $i.Created
    $snap.started_at     = $i.State.StartedAt
    $vols = @()
    foreach ($m in $i.Mounts) {
      if ($m.Type -eq "volume" -and $m.Name) { $vols += $m.Name }
    }
    $snap.named_volumes = $vols
  } catch {
    # leave the half-filled snapshot; receipt will show it
  }
  return $snap
}

function Test-ExcludedPath([string]$relPath) {
  foreach ($g in $EXCLUDE_GLOBS) {
    # Normalize separators; treat $g as a prefix glob (ends with *).
    $gn = $g -replace '/','\'
    if ($gn.EndsWith("\*")) {
      $prefix = $gn.Substring(0, $gn.Length - 2)
      if ($relPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    } elseif ($gn -eq $relPath) {
      return $true
    } elseif ($relPath.Equals($gn, [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
}

function Get-ScanFiles {
  # Manual recursion so we can PRUNE noisy directories (node_modules, .git,
  # build output, this migration tree) at enumeration time instead of after
  # the fact. Recursing into node_modules takes the script from seconds to
  # minutes for zero added signal.
  param(
    [string]$Root,
    [string[]]$Extensions,
    [string[]]$PruneDirs
  )
  $extSet = @{}
  foreach ($e in $Extensions) { $extSet[$e.ToLowerInvariant()] = $true }
  $pruneSet = @{}
  foreach ($d in $PruneDirs) { $pruneSet[$d.ToLowerInvariant()] = $true }

  $stack = New-Object System.Collections.Generic.Stack[string]
  $stack.Push($Root)
  $out = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    try {
      $dirInfo = [System.IO.DirectoryInfo]::new($cur)
      foreach ($child in $dirInfo.EnumerateFileSystemInfos()) {
        if ($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }
        if ($child -is [System.IO.DirectoryInfo]) {
          if ($pruneSet.ContainsKey($child.Name.ToLowerInvariant())) { continue }
          $stack.Push($child.FullName)
        } else {
          $ext = $child.Extension.ToLowerInvariant()
          if ($extSet.ContainsKey($ext)) { $out.Add($child) | Out-Null }
        }
      }
    } catch {
      # Permission denied / vanished dir — skip silently.
    }
  }
  return $out
}

function Find-ConsumerHits {
  param(
    [string]$Adapter,
    [string[]]$Patterns
  )
  $hits = New-Object System.Collections.Generic.List[object]
  # Scan source-ish files only.
  $exts = @(".mjs",".js",".cjs",".ts",".tsx",".json",".md",".yml",".yaml",".ps1",".sh",".py")
  $pruneDirs = @('node_modules','.git','.next','.cache','.turbo','dist','build','out','coverage','codexa-migration')
  $files = Get-ScanFiles -Root $ORANGE5_ROOT -Extensions $exts -PruneDirs $pruneDirs
  if ($files.Count -eq 0) { return $hits }
  # Filter out exclude-list files up front so Select-String operates on the
  # smallest possible file set. Build a [FileInfo[]] for Select-String -Path.
  $scanList = New-Object System.Collections.Generic.List[System.IO.FileInfo]
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($ORANGE5_ROOT.Length).TrimStart('\')
    if (Test-ExcludedPath $rel) { continue }
    $scanList.Add($f) | Out-Null
  }
  if ($scanList.Count -eq 0) { return $hits }
  # Single Select-String pass with the alternation of all patterns. This is
  # native PowerShell + .NET regex, dramatically faster than per-file
  # Get-Content + foreach line. Each $Patterns entry is already a regex.
  $combined = "(?:" + (($Patterns | ForEach-Object { "(?:$_)" }) -join "|") + ")"
  $matches = $scanList | Select-String -Pattern $combined -AllMatches -ErrorAction SilentlyContinue
  foreach ($m in $matches) {
    $rel = $m.Path.Substring($ORANGE5_ROOT.Length).TrimStart('\')
    # Identify which sub-pattern matched (first hit on the line).
    $patHit = ""
    foreach ($p in $Patterns) {
      if ($m.Line -match $p) { $patHit = $p; break }
    }
    $lineTrim = $m.Line.Trim() -replace '\s+',' '
    $snippet  = if ($lineTrim.Length -gt 200) { $lineTrim.Substring(0,200) } else { $lineTrim }
    $hits.Add([pscustomobject]@{
      file    = $rel
      line    = $m.LineNumber
      pattern = $patHit
      snippet = $snippet
    }) | Out-Null
  }
  return $hits
}

function Resolve-Verdict {
  param(
    [int]$HitCount,
    [bool]$EnvSet,
    [bool]$Strict
  )
  if ($HitCount -gt 0) { return "IN-USE" }
  if ($EnvSet) {
    if ($Strict) { return "IN-USE" } else { return "AMBIGUOUS" }
  }
  return "RETIRABLE"
}

# --- Phase 0: pre-flight ----------------------------------------------------
Banner "PHASE 0 -- pre-flight (read-only)"

if (-not (Test-Path -LiteralPath $ORANGE5_ROOT)) {
  Add-Step "0" "Orange5 root exists" "red" $ORANGE5_ROOT
  Write-Host "FATAL: Orange5 root missing." -ForegroundColor Red
  exit 2
}
Add-Step "0" "Orange5 root exists" "green" $ORANGE5_ROOT

if (-not (Test-Path -LiteralPath $RECEIPT_DIR)) {
  try {
    New-Item -ItemType Directory -Force -Path $RECEIPT_DIR | Out-Null
    Add-Step "0" "receipt dir exists" "green" ("created {0}" -f $RECEIPT_DIR)
  } catch {
    Add-Step "0" "receipt dir exists" "red" $_.Exception.Message
    exit 2
  }
} else {
  Add-Step "0" "receipt dir exists" "green" $RECEIPT_DIR
}

$dockerOk = Test-DockerAvailable
if ($dockerOk) {
  Add-Step "0" "docker daemon reachable" "green" ""
} else {
  Add-Step "0" "docker daemon reachable" "yellow" "docker not reachable; live container probe will be SKIPPED -- code-side evidence still counts"
}

# --- Phase 1: codebase scan -------------------------------------------------
Banner "PHASE 1 -- codebase scan (postgres + redis consumers)"

$pgHits    = Find-ConsumerHits -Adapter "postgres" -Patterns $PG_PATTERNS
$redisHits = Find-ConsumerHits -Adapter "redis"    -Patterns $REDIS_PATTERNS

Add-Step "1" "postgres consumer hits" $([string]::Empty + $(if ($pgHits.Count -gt 0) { "yellow" } else { "green" })) ("count={0}" -f $pgHits.Count)
Add-Step "1" "redis consumer hits"    $([string]::Empty + $(if ($redisHits.Count -gt 0) { "yellow" } else { "green" })) ("count={0}" -f $redisHits.Count)

# --- Phase 2: live container probe ------------------------------------------
Banner "PHASE 2 -- live container probe (inspection only, no mutation)"

$pgSnap    = $null
$redisSnap = $null
if ($SkipContainers) {
  Add-Step "2" "container snapshot" "skip" "-SkipContainers set"
} elseif (-not $dockerOk) {
  Add-Step "2" "container snapshot" "skip" "docker unreachable"
} else {
  $pgSnap    = Get-ContainerSnapshot $PG_CONTAINER
  $redisSnap = Get-ContainerSnapshot $REDIS_CONTAINER
  Add-Step "2" ("snapshot {0}" -f $PG_CONTAINER) "info" ("exists={0} running={1} image={2} volumes={3}" -f $pgSnap.exists, $pgSnap.running, $pgSnap.image, ($pgSnap.named_volumes -join ','))
  Add-Step "2" ("snapshot {0}" -f $REDIS_CONTAINER) "info" ("exists={0} running={1} image={2} volumes={3}" -f $redisSnap.exists, $redisSnap.running, $redisSnap.image, ($redisSnap.named_volumes -join ','))
}

# --- Phase 3: env probe -----------------------------------------------------
Banner "PHASE 3 -- env probe"

$pgEnvSet    = -not [string]::IsNullOrEmpty($env:ATOMEONS_PG_URL)
$redisEnvSet = -not [string]::IsNullOrEmpty($env:REDIS_URL)
Add-Step "3" "ATOMEONS_PG_URL set" $([string]::Empty + $(if ($pgEnvSet) { "yellow" } else { "green" })) ("set={0}" -f $pgEnvSet)
Add-Step "3" "REDIS_URL set"       $([string]::Empty + $(if ($redisEnvSet) { "yellow" } else { "green" })) ("set={0}" -f $redisEnvSet)

# --- Phase 4: verdict -------------------------------------------------------
Banner "PHASE 4 -- verdict"

$pgVerdict    = Resolve-Verdict -HitCount $pgHits.Count    -EnvSet $pgEnvSet    -Strict:$Strict.IsPresent
$redisVerdict = Resolve-Verdict -HitCount $redisHits.Count -EnvSet $redisEnvSet -Strict:$Strict.IsPresent

$pgColor    = switch ($pgVerdict)    { "RETIRABLE" { "green" } "AMBIGUOUS" { "yellow" } "IN-USE" { "red" } }
$redisColor = switch ($redisVerdict) { "RETIRABLE" { "green" } "AMBIGUOUS" { "yellow" } "IN-USE" { "red" } }
Add-Step "4" "postgres verdict" $pgColor    $pgVerdict
Add-Step "4" "redis verdict"    $redisColor $redisVerdict

# --- Phase 5: receipt -------------------------------------------------------
Banner "PHASE 5 -- emit receipt"

function Format-HitTable {
  param([System.Collections.Generic.List[object]]$Hits)
  if ($Hits.Count -eq 0) { return "_(no consumer hits)_" }
  $out = New-Object System.Collections.Generic.List[string]
  $out.Add("| File | Line | Pattern | Snippet |") | Out-Null
  $out.Add("|------|------|---------|---------|") | Out-Null
  foreach ($h in $Hits) {
    $snip = ($h.snippet -replace '\|','\|')
    $pat  = ($h.pattern -replace '\|','\|')
    $out.Add(("| ``{0}`` | {1} | ``{2}`` | ``{3}`` |" -f $h.file, $h.line, $pat, $snip)) | Out-Null
  }
  return ($out -join "`n")
}

function Format-Snapshot {
  param($Snap)
  if ($null -eq $Snap) { return "_(probe skipped)_" }
  if (-not $Snap.exists) { return ("_(container ``{0}`` not found on this host)_" -f $Snap.name) }
  $vols = if ($Snap.named_volumes.Count -gt 0) { $Snap.named_volumes -join ', ' } else { '(none)' }
  return @(
    "- name: ``$($Snap.name)``"
    "- exists: $($Snap.exists)"
    "- running: $($Snap.running)"
    "- image: ``$($Snap.image)``"
    "- image_digest: ``$($Snap.image_digest)``"
    "- restart_policy: $($Snap.restart_policy)"
    "- created_at: $($Snap.created_at)"
    "- started_at: $($Snap.started_at)"
    "- named_volumes: $vols"
  ) -join "`n"
}

$rc = New-Object System.Collections.Generic.List[string]
$rc.Add("# Codexa migration W2 -- evaluate postgres + redis") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("- Date (UTC): {0}" -f $TS_UTC)) | Out-Null
$rc.Add(("- Strict mode: {0}" -f $Strict.IsPresent)) | Out-Null
$rc.Add(("- SkipContainers: {0}" -f $SkipContainers.IsPresent)) | Out-Null
$rc.Add(("- Docker reachable: {0}" -f $dockerOk)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Verdicts") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| Adapter | Verdict | Consumer hits | Env set |") | Out-Null
$rc.Add("|---------|---------|---------------|---------|") | Out-Null
$rc.Add(("| postgres | **{0}** | {1} | ATOMEONS_PG_URL={2} |" -f $pgVerdict,    $pgHits.Count,    $pgEnvSet))    | Out-Null
$rc.Add(("| redis    | **{0}** | {1} | REDIS_URL={2} |"       -f $redisVerdict, $redisHits.Count, $redisEnvSet)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## What the verdicts mean") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- **RETIRABLE** -- zero consumer hits in Orange5 outside the adapter file, registry index, SPEC, tests, and migration scripts. The legacy Codexa backend is a candidate for retirement. The kill is still gated on the No-Take-Down Law: backup volume(s), verify no inbound traffic for one quiet day, then run the destructive script.") | Out-Null
$rc.Add("- **AMBIGUOUS** -- zero consumer hits, but the env variable is plumbed. The adapter is wired for use but nothing calls it yet. Operator decides; do NOT retire until ambiguity is resolved (either by deleting the env or by promoting a consumer). Re-run with ``-Strict`` to treat this as IN-USE for unattended cron evaluation.") | Out-Null
$rc.Add("- **IN-USE** -- one or more consumer hits found outside the exclusion list. Backend is live; retirement is BLOCKED. See the hit tables below.") | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## postgres consumer hits") | Out-Null
$rc.Add("") | Out-Null
$rc.Add((Format-HitTable -Hits $pgHits)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## redis consumer hits") | Out-Null
$rc.Add("") | Out-Null
$rc.Add((Format-HitTable -Hits $redisHits)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Live container snapshot") | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("### {0}" -f $PG_CONTAINER)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add((Format-Snapshot -Snap $pgSnap)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add(("### {0}" -f $REDIS_CONTAINER)) | Out-Null
$rc.Add("") | Out-Null
$rc.Add((Format-Snapshot -Snap $redisSnap)) | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Steps") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("| Phase | Status | Title | Detail |") | Out-Null
$rc.Add("|-------|--------|-------|--------|") | Out-Null
foreach ($s in $steps) {
  $detail = ($s.detail -replace '\|','\|')
  $rc.Add(("| {0} | {1} | {2} | {3} |" -f $s.phase, $s.status, $s.title, $detail)) | Out-Null
}
$rc.Add("") | Out-Null

$rc.Add("## Proposed retirement order (only for RETIRABLE adapters)") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("This script does NOT kill anything. It only proposes the order. The operator must author and run a destructive sibling script (e.g. ``05-kill-postgres.ps1``, ``06-kill-redis.ps1``) modeled on ``01-kill-open-webui.ps1``, with the same gates:") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("1. Pre-flight -- verify replacement is healthy (or ``-SkipGatewayCheck`` with loud yellow row).") | Out-Null
$rc.Add("2. Inspect container; capture image + named volumes + restart policy.") | Out-Null
$rc.Add("3. Back up each named volume to ``" + $MIGRATION_ROOT_WIN + "`` as ``<service>-<UTC-date>.tar.gz``; SHA-256; refuse on small archive.") | Out-Null
$rc.Add("4. Snapshot metadata to ``<service>-<UTC-date>.meta.json`` (image digest, mounts, env minus secrets).") | Out-Null
$rc.Add("5. ``docker stop --time 30`` then ``docker rm``. Image stays cached unless ``-ReclaimImage``.") | Out-Null
$rc.Add("6. Emit a Markdown receipt to ``10-RECEIPTS/codexa-migration/``.") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("Suggested scheduled window: any RETIRABLE adapter -> kill at W2 close, one quiet day after this evaluation, paired with a rollback script that restores the volume tar into a fresh named volume + recreates the container.") | Out-Null
$rc.Add("") | Out-Null

$rc.Add("## Doctrine") | Out-Null
$rc.Add("") | Out-Null
$rc.Add("- Mom's Law: receipts only, no theater.") | Out-Null
$rc.Add("- No-Take-Down Law: this script is read-only; nothing dies without an explicit destructive script and operator authorization.") | Out-Null
$rc.Add("- Receipt #013: open-webui + n8n at W1 close, orangebox-wiki at W2 close, KEEP qdrant, EVALUATE postgres + redis (this script).") | Out-Null
$rc.Add("- Exclusion list (mentions here are descriptive, not consuming): " + (($EXCLUDE_GLOBS | ForEach-Object { '``' + $_ + '``' }) -join ', ')) | Out-Null

Set-Content -LiteralPath $RECEIPT_PATH -Value ($rc -join "`n") -Encoding utf8
Write-Host ("Receipt: {0}" -f $RECEIPT_PATH) -ForegroundColor Green

if ($OutputJson) {
  $jsonOut = [ordered]@{
    date_utc          = $TS_UTC
    strict            = $Strict.IsPresent
    skip_containers   = $SkipContainers.IsPresent
    docker_reachable  = $dockerOk
    postgres = [ordered]@{
      verdict      = $pgVerdict
      hit_count    = $pgHits.Count
      env_set      = $pgEnvSet
      env_var_name = "ATOMEONS_PG_URL"
      container    = $pgSnap
      hits         = $pgHits
    }
    redis = [ordered]@{
      verdict      = $redisVerdict
      hit_count    = $redisHits.Count
      env_set      = $redisEnvSet
      env_var_name = "REDIS_URL"
      container    = $redisSnap
      hits         = $redisHits
    }
    steps             = $steps
    exclude_globs     = $EXCLUDE_GLOBS
    pg_patterns       = $PG_PATTERNS
    redis_patterns    = $REDIS_PATTERNS
    receipt_md_path   = $RECEIPT_PATH
    receipt_json_path = $RECEIPT_JSON_PATH
    doctrine_ref      = "receipt #013 (W2 close)"
  }
  $jsonOut | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $RECEIPT_JSON_PATH -Encoding utf8
  Write-Host ("Receipt JSON: {0}" -f $RECEIPT_JSON_PATH) -ForegroundColor Green
}

Write-Host ""
Write-Host ("Verdict :: postgres={0}  redis={1}" -f $pgVerdict, $redisVerdict) -ForegroundColor Cyan
Write-Host "Result: GREEN (evaluation complete, no destructive action taken)." -ForegroundColor Green
exit 0
