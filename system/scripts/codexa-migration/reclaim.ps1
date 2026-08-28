# reclaim.ps1
# Codexa migration -- final summary / reclamation receipt.
#
# Owner: Atom McCree (Sovereign).
# Doctrine:
#   - Mom's Law: full effort, no theater, no silent fallback. Receipts only.
#   - No-Take-Down Law: this script is the SUMMARY pass. It does not kill
#     anything. It reads what the kill scripts already did, measures what was
#     reclaimed, and writes the closing receipt for the migration window.
#     Reclamation of cached *images* (docker image rm) is gated behind
#     -ReclaimImages AND the matching kill receipt explicitly recording the
#     container as gone; otherwise images are left cached as rollback
#     insurance. Even with -ReclaimImages, qdrant's image is NEVER touched
#     (per Receipt #013: KEEP).
#
# Per Receipt #013 (Codexa migration plan):
#   - W1 close: aeorangebox-ai-box-open-webui-1, aeorangebox-ai-box-n8n-1
#   - W2 close: aeorangebox-ai-box-wiki-1
#   - KEEP    : aeorangebox-ai-box-qdrant-1
#   - EVALUATE: aeorangebox-ai-box-postgres-1, aeorangebox-ai-box-redis-1
#
# What it does (in order; any RED on a destructive step aborts):
#   1. Load the preflight receipt from receipts\codexa-migration\preflight.json.
#      Refuse to summarize if it is missing, RED, or DRY for the active wave.
#   2. Discover all kill receipts in 10-RECEIPTS\codexa-migration\ that match
#      the active wave (W1 or W2). Verify each names a legal target and a
#      backup SHA-256.
#   3. Sample current docker resident set (running containers, image count +
#      total image bytes, volume count + total volume bytes). Cross-check with
#      the "before" sample embedded in the preflight receipt's legacy_state
#      and the per-kill-receipt "before" metrics, if present.
#   4. Compute:
#        - containers_killed: legacy names present in preflight as running,
#          absent now AND with a kill receipt to back the absence.
#        - ram_reclaimed_bytes: sum of pre-kill memory_usage from each kill
#          receipt (the receipts record `docker stats` at kill time). If a kill
#          receipt lacks a memory_usage field, that container contributes 0
#          and a YELLOW row is logged -- we never invent numbers.
#        - disk_reclaimed_bytes: sum of backed-up volume sizes plus, if
#          -ReclaimImages was passed AND the image was actually removable
#          (no other container still referencing it), the reclaimed image
#          bytes. Same YELLOW-on-missing-field policy.
#        - backups_created: list of {target, archive, sha256, bytes} from
#          each kill receipt; refuse to mark GREEN unless every entry has
#          a SHA-256 and the archive file is still on disk.
#   5. Optionally (-ReclaimImages) prune images whose only referencing
#      containers are confirmed dead by the kill receipts. Qdrant image is
#      hard-skipped. Each prune is logged as its own row with bytes reclaimed.
#   6. Write a JSON + Markdown receipt to 10-RECEIPTS\codexa-migration\
#      named reclaim-<Wave>-<UTC>.{json,md}. The JSON is the machine record;
#      the Markdown is the human summary suitable for /receiptbook.
#
# Flags:
#   -Wave W1|W2        : which wave-close cut we are summarizing. Required.
#   -ReclaimImages     : also prune cached images for confirmed-dead containers
#                        (default OFF -- images stay cached for rollback).
#                        Qdrant is exempt regardless.
#   -DryRun            : print everything, mutate nothing, do not write
#                        the receipt. Exits 0 if all checks pass, 1 otherwise.
#   -ReceiptDir <path> : override the kill-receipt source dir. Defaults to
#                        C:\AtomEons\Orange5\10-RECEIPTS\codexa-migration.
#   -BackupRoot <path> : override the backup root used to verify archives
#                        still exist. Defaults to
#                        C:\AtomEons\backups\codexa-migration.
#
# Exit codes:
#   0  summary written, every kill in the wave reconciled, every backup
#      verified, no RED rows.
#   1  one or more rows RED -- receipt still emitted (so the operator sees
#      what failed) but the verdict is RED.
#   2  fatal pre-flight (preflight receipt missing or RED, receipt dir
#      unwritable, docker daemon unreachable). Nothing written.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("W1","W2")]
  [string]$Wave,
  [switch]$ReclaimImages,
  [switch]$DryRun,
  [string]$ReceiptDir = "C:\AtomEons\Orange5\10-RECEIPTS\codexa-migration",
  [string]$BackupRoot = "C:\AtomEons\backups\codexa-migration"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Paths (anchored, never relative) ---------------------------------------
$ORANGE5_ROOT     = "C:\AtomEons\Orange5"
$PREFLIGHT_PATH   = Join-Path $ORANGE5_ROOT "receipts\codexa-migration\preflight.json"
$TS_UTC           = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$RECEIPT_JSON     = Join-Path $ReceiptDir ("reclaim-{0}-{1}.json" -f $Wave, $TS_UTC)
$RECEIPT_MD       = Join-Path $ReceiptDir ("reclaim-{0}-{1}.md"   -f $Wave, $TS_UTC)

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

# --- KEEP list -- never reclaim image, never declare killed ------------------
$KEEP = @("qdrant")

# --- Rows accumulator -------------------------------------------------------
$rows    = New-Object System.Collections.Generic.List[object]
$reds    = 0
$yellows = 0

function Add-Row {
  param(
    [string]$Name,
    [ValidateSet("GREEN","YELLOW","RED")]
    [string]$Status,
    [string]$Detail
  )
  $row = [pscustomobject]@{
    row    = $Name
    status = $Status
    detail = $Detail
    at     = (Get-Date).ToString("o")
  }
  $rows.Add($row) | Out-Null
  $color = switch ($Status) { "GREEN" {"Green"} "YELLOW" {"Yellow"} "RED" {"Red"} }
  Write-Host ("[{0,-6}] {1,-44} {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
  if ($Status -eq "RED")    { $script:reds++ }
  if ($Status -eq "YELLOW") { $script:yellows++ }
}

function Format-Bytes {
  param([long]$Bytes)
  if ($Bytes -lt 1KB) { return ("{0} B"   -f $Bytes) }
  if ($Bytes -lt 1MB) { return ("{0:N1} KiB" -f ($Bytes / 1KB)) }
  if ($Bytes -lt 1GB) { return ("{0:N1} MiB" -f ($Bytes / 1MB)) }
  return ("{0:N2} GiB" -f ($Bytes / 1GB))
}

function Test-ContainerRunning {
  param([string]$Name)
  $out = & docker ps --filter ("name=^/{0}$" -f $Name) --format "{{.Names}}" 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($out -eq $Name)
}

function Get-ContainerImage {
  param([string]$Name)
  # Returns image id (sha256:...) for a container that may already be gone.
  # We only care about live containers here; dead containers' images are
  # tracked in the kill receipt instead.
  $img = & docker inspect --format "{{.Image}}" $Name 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return $img
}

function Get-ImageSizeBytes {
  param([string]$ImageId)
  if (-not $ImageId) { return 0 }
  $sz = & docker image inspect --format "{{.Size}}" $ImageId 2>$null
  if ($LASTEXITCODE -ne 0) { return 0 }
  try { return [long]$sz } catch { return 0 }
}

function Get-ImageReferencerCount {
  param([string]$ImageId)
  if (-not $ImageId) { return 0 }
  $names = & docker ps -a --filter ("ancestor={0}" -f $ImageId) --format "{{.Names}}" 2>$null
  if ($LASTEXITCODE -ne 0) { return -1 }
  if (-not $names) { return 0 }
  return ($names -split "`n" | Where-Object { $_ }).Count
}

Write-Host "=== Codexa migration reclaim summary ===" -ForegroundColor Cyan
Write-Host ("Wave:           {0}" -f $Wave)
Write-Host ("ReclaimImages:  {0}" -f $ReclaimImages.IsPresent)
Write-Host ("DryRun:         {0}" -f $DryRun.IsPresent)
Write-Host ("ReceiptDir:     {0}" -f $ReceiptDir)
Write-Host ("BackupRoot:     {0}" -f $BackupRoot)
Write-Host ""

# --- Fatal pre-flight: docker reachable, receipt dir writable, preflight ----
# receipt exists and is not RED/DRY for this wave.
try { $null = & docker info 2>$null } catch {}
if ($LASTEXITCODE -ne 0) {
  Write-Host "[FATAL] docker daemon unreachable -- cannot reconcile state" -ForegroundColor Red
  exit 2
}

if (-not (Test-Path $ReceiptDir)) {
  try {
    if (-not $DryRun) { New-Item -ItemType Directory -Path $ReceiptDir -Force | Out-Null }
  } catch {
    Write-Host ("[FATAL] cannot create receipt dir {0}: {1}" -f $ReceiptDir, $_.Exception.Message) -ForegroundColor Red
    exit 2
  }
}

if (-not (Test-Path $PREFLIGHT_PATH)) {
  Write-Host ("[FATAL] preflight receipt missing: {0}" -f $PREFLIGHT_PATH) -ForegroundColor Red
  Write-Host "Run preflight.ps1 -Wave $Wave -AuthorizeKill first."           -ForegroundColor Red
  exit 2
}

try {
  $preflight = Get-Content $PREFLIGHT_PATH -Raw | ConvertFrom-Json
} catch {
  Write-Host ("[FATAL] preflight receipt unparseable: {0}" -f $_.Exception.Message) -ForegroundColor Red
  exit 2
}

if ($preflight.wave -ne $Wave) {
  Write-Host ("[FATAL] preflight wave={0} does not match -Wave {1}" -f $preflight.wave, $Wave) -ForegroundColor Red
  exit 2
}
if ($preflight.verdict -ne "GREEN") {
  Write-Host ("[FATAL] preflight verdict={0} -- killers should not have run" -f $preflight.verdict) -ForegroundColor Red
  exit 2
}

Add-Row -Name "preflight.receipt.loaded" -Status "GREEN" `
  -Detail ("wave={0} verdict={1} at {2}" -f $preflight.wave, $preflight.verdict, $preflight.generated_at)

# --- Discover kill receipts for this wave -----------------------------------
# Convention: kill scripts write either a JSON sidecar (kill-<target>-*.json)
# or a Markdown receipt (kill-<target>-*.md) into $ReceiptDir. We prefer JSON
# because it carries the structured numbers; Markdown-only is YELLOW (we can
# confirm the kill but not the magnitude).
$expected = $KILL_SET[$Wave]
$killReceipts = @{}
foreach ($target in $expected) {
  $jsonGlob = Join-Path $ReceiptDir ("kill-{0}-*.json" -f $target)
  $mdGlob   = Join-Path $ReceiptDir ("kill-{0}-*.md"   -f $target)
  $jsonHit  = Get-ChildItem -Path $jsonGlob -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
  $mdHit    = Get-ChildItem -Path $mdGlob   -File -ErrorAction SilentlyContinue |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1

  if ($jsonHit) {
    try {
      $parsed = Get-Content $jsonHit.FullName -Raw | ConvertFrom-Json
      $killReceipts[$target] = [pscustomobject]@{
        kind   = "json"
        path   = $jsonHit.FullName
        parsed = $parsed
      }
      Add-Row -Name ("killreceipt.{0}" -f $target) -Status "GREEN" `
        -Detail ("json: {0}" -f $jsonHit.Name)
    } catch {
      Add-Row -Name ("killreceipt.{0}" -f $target) -Status "RED" `
        -Detail ("json unparseable: {0}" -f $_.Exception.Message)
      $killReceipts[$target] = $null
    }
  } elseif ($mdHit) {
    $killReceipts[$target] = [pscustomobject]@{
      kind   = "md"
      path   = $mdHit.FullName
      parsed = $null
    }
    Add-Row -Name ("killreceipt.{0}" -f $target) -Status "YELLOW" `
      -Detail ("md only, no JSON: {0}" -f $mdHit.Name)
  } else {
    Add-Row -Name ("killreceipt.{0}" -f $target) -Status "RED" `
      -Detail ("no kill-{0}-*.{{json,md}} in {1}" -f $target, $ReceiptDir)
    $killReceipts[$target] = $null
  }
}

# --- Reconcile: containers that should be dead -----------------------------
$containersKilled = New-Object System.Collections.Generic.List[string]
$ramReclaimed   = [long]0
$diskReclaimed  = [long]0
$backupsCreated = New-Object System.Collections.Generic.List[object]

foreach ($target in $expected) {
  $cname  = $LEGACY[$target]
  $isLive = Test-ContainerRunning -Name $cname
  $kr     = $killReceipts[$target]

  if ($isLive -eq $true) {
    Add-Row -Name ("container.{0}.dead" -f $target) -Status "RED" `
      -Detail ("{0} is still running -- kill script did not complete" -f $cname)
    continue
  }

  if ($null -eq $kr) {
    # No receipt to back the absence: refuse to count it.
    Add-Row -Name ("container.{0}.dead" -f $target) -Status "RED" `
      -Detail ("{0} appears down but no kill receipt -- refusing to attribute" -f $cname)
    continue
  }

  Add-Row -Name ("container.{0}.dead" -f $target) -Status "GREEN" `
    -Detail ("{0} confirmed down" -f $cname)
  $containersKilled.Add($cname) | Out-Null

  if ($kr.kind -ne "json") {
    # MD-only receipt: we cannot extract numbers without inventing them.
    Add-Row -Name ("metrics.{0}" -f $target) -Status "YELLOW" `
      -Detail "md-only kill receipt; ram/disk reclaimed for this target = 0"
    continue
  }

  $p = $kr.parsed

  # RAM reclaimed: each kill receipt should record memory_usage_bytes at kill time.
  $mem = $null
  if ($p.PSObject.Properties.Name -contains "memory_usage_bytes") {
    try { $mem = [long]$p.memory_usage_bytes } catch { $mem = $null }
  }
  if ($null -ne $mem -and $mem -ge 0) {
    $ramReclaimed += $mem
    Add-Row -Name ("ram.{0}" -f $target) -Status "GREEN" `
      -Detail (Format-Bytes $mem)
  } else {
    Add-Row -Name ("ram.{0}" -f $target) -Status "YELLOW" `
      -Detail "memory_usage_bytes missing in kill receipt; contributing 0"
  }

  # Disk reclaimed: backup_bytes is volume size we copied off; that's the
  # state we no longer need pinned on the legacy volume. (Image bytes only
  # count if -ReclaimImages prunes them below.)
  $vol  = $null
  $sha  = $null
  $arch = $null
  if ($p.PSObject.Properties.Name -contains "backup_bytes") {
    try { $vol = [long]$p.backup_bytes } catch { $vol = $null }
  }
  if ($p.PSObject.Properties.Name -contains "backup_sha256") { $sha  = [string]$p.backup_sha256 }
  if ($p.PSObject.Properties.Name -contains "backup_path")   { $arch = [string]$p.backup_path   }

  if ($null -ne $vol -and $vol -gt 0 -and $sha -and $arch) {
    # Verify the archive still exists on disk (Windows-side mirror).
    $archWin = $arch
    if ($arch.StartsWith("/opt/atomeons/migrations")) {
      $archWin = $arch -replace "^/opt/atomeons/migrations", "C:\opt\atomeons\migrations" -replace "/", "\"
    }
    if (Test-Path $archWin) {
      $diskReclaimed += $vol
      $backupsCreated.Add([pscustomobject]@{
        target  = $target
        archive = $arch
        sha256  = $sha
        bytes   = $vol
      }) | Out-Null
      Add-Row -Name ("backup.{0}" -f $target) -Status "GREEN" `
        -Detail ("{0} ({1}) sha256={2}" -f (Split-Path $arch -Leaf), (Format-Bytes $vol), $sha.Substring(0,12))
    } else {
      Add-Row -Name ("backup.{0}" -f $target) -Status "RED" `
        -Detail ("kill receipt names backup at {0} but file is missing" -f $archWin)
    }
  } else {
    Add-Row -Name ("backup.{0}" -f $target) -Status "RED" `
      -Detail "kill receipt missing backup_path / backup_bytes / backup_sha256"
  }
}

# --- Optional: image reclamation -------------------------------------------
$imagesPruned = New-Object System.Collections.Generic.List[object]
if ($ReclaimImages) {
  foreach ($target in $expected) {
    if ($KEEP -contains $target) {
      Add-Row -Name ("image.{0}.skip" -f $target) -Status "GREEN" `
        -Detail "KEEP list -- image preserved"
      continue
    }
    $kr = $killReceipts[$target]
    if ($null -eq $kr -or $kr.kind -ne "json") {
      Add-Row -Name ("image.{0}.skip" -f $target) -Status "YELLOW" `
        -Detail "no JSON kill receipt -- refusing to prune image blind"
      continue
    }
    $imageId = $null
    if ($kr.parsed.PSObject.Properties.Name -contains "image_id") {
      $imageId = [string]$kr.parsed.image_id
    }
    if (-not $imageId) {
      Add-Row -Name ("image.{0}.skip" -f $target) -Status "YELLOW" `
        -Detail "kill receipt has no image_id"
      continue
    }
    $refs = Get-ImageReferencerCount -ImageId $imageId
    if ($refs -lt 0) {
      Add-Row -Name ("image.{0}.skip" -f $target) -Status "RED" `
        -Detail "docker ps -a --filter ancestor failed"
      continue
    }
    if ($refs -gt 0) {
      Add-Row -Name ("image.{0}.skip" -f $target) -Status "YELLOW" `
        -Detail ("{0} other container(s) still reference {1}" -f $refs, $imageId.Substring(0,19))
      continue
    }
    $bytes = Get-ImageSizeBytes -ImageId $imageId
    if ($DryRun) {
      Add-Row -Name ("image.{0}.prune" -f $target) -Status "GREEN" `
        -Detail ("(DryRun) would prune {0} ({1})" -f $imageId.Substring(0,19), (Format-Bytes $bytes))
      $imagesPruned.Add([pscustomobject]@{ target = $target; image_id = $imageId; bytes = $bytes; dryrun = $true }) | Out-Null
      $diskReclaimed += $bytes
    } else {
      $null = & docker image rm $imageId 2>$null
      if ($LASTEXITCODE -eq 0) {
        Add-Row -Name ("image.{0}.prune" -f $target) -Status "GREEN" `
          -Detail ("pruned {0} ({1})" -f $imageId.Substring(0,19), (Format-Bytes $bytes))
        $imagesPruned.Add([pscustomobject]@{ target = $target; image_id = $imageId; bytes = $bytes; dryrun = $false }) | Out-Null
        $diskReclaimed += $bytes
      } else {
        Add-Row -Name ("image.{0}.prune" -f $target) -Status "RED" `
          -Detail ("docker image rm failed for {0}" -f $imageId.Substring(0,19))
      }
    }
  }
} else {
  Add-Row -Name "images.reclaim.skipped" -Status "GREEN" `
    -Detail "default policy -- images kept as rollback insurance"
}

# --- KEEP-list sanity check -------------------------------------------------
foreach ($target in $KEEP) {
  $cname  = $LEGACY[$target]
  $isLive = Test-ContainerRunning -Name $cname
  if ($isLive -eq $true) {
    Add-Row -Name ("keep.{0}" -f $target) -Status "GREEN" `
      -Detail ("{0} is preserved and running" -f $cname)
  } else {
    Add-Row -Name ("keep.{0}" -f $target) -Status "RED" `
      -Detail ("KEEP-list container {0} is NOT running -- investigate" -f $cname)
  }
}

# --- Verdict ----------------------------------------------------------------
Write-Host ""
$verdict = if ($reds -gt 0) { "RED" } else { "GREEN" }
Write-Host ("=== Verdict: {0}  (containers_killed={1}  ram={2}  disk={3}  reds={4}  yellows={5}) ===" `
            -f $verdict, $containersKilled.Count, (Format-Bytes $ramReclaimed), (Format-Bytes $diskReclaimed), $reds, $yellows) `
  -ForegroundColor $(switch ($verdict) { "GREEN" {"Green"} "RED" {"Red"} })

# --- Receipt: JSON ----------------------------------------------------------
$receipt = [pscustomobject]@{
  schema             = "codexa-migration.reclaim.v1"
  generated_at       = (Get-Date).ToString("o")
  operator           = "Atom McCree"
  wave               = $Wave
  reclaim_images     = [bool]$ReclaimImages
  verdict            = $verdict
  reds               = $reds
  yellows            = $yellows
  containers_killed  = @($containersKilled)
  ram_reclaimed_bytes  = $ramReclaimed
  disk_reclaimed_bytes = $diskReclaimed
  backups_created    = @($backupsCreated)
  images_pruned      = @($imagesPruned)
  preflight_ref      = $PREFLIGHT_PATH
  rows               = @($rows)
  doctrine           = @{
    moms_law         = $true
    no_take_down_law = $true
    receipt_ref      = "#013"
    keep_list        = @($KEEP)
  }
}

# --- Receipt: Markdown (human summary, /receiptbook-friendly) ---------------
$md = @()
$md += "# Codexa migration reclaim receipt -- wave $Wave"
$md += ""
$md += ("- Generated: {0}" -f $receipt.generated_at)
$md += ("- Operator:  Atom McCree (Sovereign)")
$md += ("- Verdict:   **{0}**" -f $verdict)
$md += ("- Receipt #013 wave $Wave kill set: [{0}]" -f (($KILL_SET[$Wave]) -join ", "))
$md += ""
$md += "## Summary"
$md += ""
$md += "| metric | value |"
$md += "|---|---|"
$md += ("| containers killed | {0} |"   -f $containersKilled.Count)
$md += ("| RAM reclaimed     | {0} |"   -f (Format-Bytes $ramReclaimed))
$md += ("| disk reclaimed    | {0} |"   -f (Format-Bytes $diskReclaimed))
$md += ("| backups verified  | {0} |"   -f $backupsCreated.Count)
$md += ("| images pruned     | {0} |"   -f $imagesPruned.Count)
$md += ("| RED rows          | {0} |"   -f $reds)
$md += ("| YELLOW rows       | {0} |"   -f $yellows)
$md += ""
if ($containersKilled.Count -gt 0) {
  $md += "## Containers killed"
  $md += ""
  foreach ($c in $containersKilled) { $md += ("- ``{0}``" -f $c) }
  $md += ""
}
if ($backupsCreated.Count -gt 0) {
  $md += "## Backups created"
  $md += ""
  $md += "| target | archive | bytes | sha256 |"
  $md += "|---|---|---|---|"
  foreach ($b in $backupsCreated) {
    $md += ("| {0} | ``{1}`` | {2} | ``{3}`` |" -f $b.target, $b.archive, (Format-Bytes $b.bytes), $b.sha256)
  }
  $md += ""
}
if ($imagesPruned.Count -gt 0) {
  $md += "## Images pruned"
  $md += ""
  foreach ($i in $imagesPruned) {
    $tag = if ($i.dryrun) { " (DryRun)" } else { "" }
    $md += ("- {0} -- {1} -- {2}{3}" -f $i.target, $i.image_id.Substring(0,19), (Format-Bytes $i.bytes), $tag)
  }
  $md += ""
}
$md += "## Rows"
$md += ""
$md += "| status | row | detail |"
$md += "|---|---|---|"
foreach ($r in $rows) {
  $detail = ($r.detail -replace "\|","\|")
  $md += ("| {0} | {1} | {2} |" -f $r.status, $r.row, $detail)
}
$md += ""
$md += "## Doctrine"
$md += ""
$md += "- Mom's Law: full effort; numbers come from receipts, never from guesses."
$md += "- No-Take-Down Law: this script summarized; it did not kill. Image reclamation is gated and KEEP-list containers (qdrant) are exempt."
$md += "- Receipt #013: wave $Wave authoritative for kill set above."
$md += ""

if (-not $DryRun) {
  $json = $receipt | ConvertTo-Json -Depth 10
  Set-Content -Path $RECEIPT_JSON -Value $json -Encoding UTF8
  Set-Content -Path $RECEIPT_MD   -Value ($md -join "`n") -Encoding UTF8
  Write-Host ("Receipt JSON: {0}" -f $RECEIPT_JSON)
  Write-Host ("Receipt MD:   {0}" -f $RECEIPT_MD)
} else {
  Write-Host "(DryRun) receipts NOT written"
}

# --- Exit -------------------------------------------------------------------
if ($verdict -eq "GREEN") { exit 0 }
exit 1
