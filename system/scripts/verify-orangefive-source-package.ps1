[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ZipPath,
  [string]$ExpectedZipSha256 = '',
  [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BytesSha256([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($Bytes)) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
  }
}

function Get-FileSha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream)) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-EntryBytes([IO.Compression.ZipArchiveEntry]$Entry) {
  $input = $Entry.Open()
  $memory = [IO.MemoryStream]::new()
  try {
    $input.CopyTo($memory)
    return $memory.ToArray()
  } finally {
    $memory.Dispose()
    $input.Dispose()
  }
}

function Get-EntryJson([Collections.Generic.Dictionary[string, object]]$Entries, [string]$Path) {
  if (-not $Entries.ContainsKey($Path)) { throw "Archive entry is missing: $Path" }
  $bytes = Get-EntryBytes $Entries[$Path]
  try { return [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json }
  catch { throw "Archive entry is not valid JSON: $Path" }
}

function Assert-SafeArchivePath([string]$Path) {
  $segments = @($Path.Split('/'))
  if (
    [string]::IsNullOrWhiteSpace($Path) -or
    $Path.Contains('\') -or
    $Path.Contains(':') -or
    [IO.Path]::IsPathRooted($Path) -or
    @($segments | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0
  ) {
    throw "Archive contains an unsafe path: $Path"
  }
}

function Get-TreeSha256([object[]]$Records) {
  $list = [Collections.Generic.List[object]]::new()
  foreach ($record in $Records) { $list.Add($record) }
  $list.Sort([Comparison[object]]{
    param($left, $right)
    return [StringComparer]::Ordinal.Compare([string]$left.path, [string]$right.path)
  })
  $builder = [Text.StringBuilder]::new()
  foreach ($record in $list) {
    [void]$builder.Append([string]$record.sha256)
    [void]$builder.Append(' ')
    [void]$builder.Append(([long]$record.bytes).ToString([Globalization.CultureInfo]::InvariantCulture))
    [void]$builder.Append(' ')
    [void]$builder.Append([string]$record.path)
    [void]$builder.Append("`n")
  }
  return Get-BytesSha256 ([Text.UTF8Encoding]::new($false).GetBytes($builder.ToString()))
}

$ZipPath = [IO.Path]::GetFullPath($ZipPath)
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) { throw "Source package does not exist: $ZipPath" }
$zipSha256 = Get-FileSha256 $ZipPath
if (-not [string]::IsNullOrWhiteSpace($ExpectedZipSha256)) {
  if ($ExpectedZipSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Expected ZIP SHA-256 is malformed.' }
  if ($zipSha256 -ne $ExpectedZipSha256.ToLowerInvariant()) { throw "ZIP SHA-256 mismatch: expected $ExpectedZipSha256, got $zipSha256" }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$stream = [IO.File]::OpenRead($ZipPath)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $false, [Text.Encoding]::UTF8)
try {
  $entries = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
  $caseInsensitivePaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $fixedTimestamp = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
  foreach ($entry in $archive.Entries) {
    $entryPath = [string]$entry.FullName
    Assert-SafeArchivePath $entryPath
    if (-not $caseInsensitivePaths.Add($entryPath)) { throw "Archive contains a case-insensitive duplicate path: $entryPath" }
    if ($entry.LastWriteTime.DateTime.Ticks -ne $fixedTimestamp.DateTime.Ticks) { throw "Archive entry timestamp is not deterministic: $entryPath" }
    $entries.Add($entryPath, $entry)
  }

  $sourceManifestPath = '00-CHARTER/LLM-DEPLOY/source-package-manifest.json'
  $sourceManifest = Get-EntryJson $entries $sourceManifestPath
  if ($sourceManifest.schema -ne 'orangefive.source-package-manifest.v1' -or $sourceManifest.product -ne 'Orange' -or $sourceManifest.release -ne 'OrangeFive') {
    throw 'Source package manifest identity is invalid.'
  }
  if ($sourceManifest.archive.name -ne [IO.Path]::GetFileName($ZipPath) -or $sourceManifest.archive.entryTimestampUtc -ne '2000-01-01T00:00:00Z') {
    throw 'Source package archive contract does not match the ZIP.'
  }
  foreach ($requiredPath in @($sourceManifest.requiredPaths)) {
    $required = [string]$requiredPath
    Assert-SafeArchivePath $required
    if (-not $entries.ContainsKey($required)) { throw "Archive is missing required current-source path: $required" }
  }

  $forbiddenSuffixes = @($sourceManifest.forbiddenFileSuffixes | ForEach-Object { ([string]$_).ToLowerInvariant() })
  foreach ($entryPath in $entries.Keys) {
    foreach ($suffix in $forbiddenSuffixes) {
      if ($entryPath.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive contains forbidden model-weight suffix: $entryPath" }
    }
  }

  $lockPath = 'orangefive.payload.lock.json'
  $payloadLock = Get-EntryJson $entries $lockPath
  if ($payloadLock.schema -ne 'orangefive.payload-lock.v1' -or $payloadLock.product -ne 'Orange' -or $payloadLock.release -ne 'OrangeFive' -or $payloadLock.hashAlgorithm -ne 'sha256') {
    throw 'Payload lock identity is invalid.'
  }
  $lockedFiles = @($payloadLock.files)
  if ([int]$payloadLock.fileCount -ne $lockedFiles.Count -or $lockedFiles.Count -ne ($entries.Count - 1)) { throw 'Payload lock file count is invalid.' }
  $lockedPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $lockedByPath = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
  foreach ($record in $lockedFiles) {
    $recordPath = [string]$record.path
    Assert-SafeArchivePath $recordPath
    if ($recordPath -eq $lockPath) { throw 'Payload lock may not lock itself.' }
    if (-not $lockedPaths.Add($recordPath)) { throw "Payload lock contains a duplicate path: $recordPath" }
    if ($record.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$record.bytes -lt 0) { throw "Payload lock metadata is invalid: $recordPath" }
    if (-not $entries.ContainsKey($recordPath)) { throw "Payload lock names a missing entry: $recordPath" }
    $entryBytes = Get-EntryBytes $entries[$recordPath]
    if ($entryBytes.Length -ne [long]$record.bytes) { throw "Payload lock byte count mismatch: $recordPath" }
    if ((Get-BytesSha256 $entryBytes) -ne [string]$record.sha256) { throw "Payload lock SHA-256 mismatch: $recordPath" }
    $lockedByPath.Add($recordPath, $record)
  }
  foreach ($entryPath in $entries.Keys) {
    if ($entryPath -ne $lockPath -and -not $lockedPaths.Contains($entryPath)) { throw "Archive entry is not covered by payload lock: $entryPath" }
  }

  $inventoryPath = [string]$sourceManifest.inventory.embeddedPath
  $inventoryShaPath = [string]$sourceManifest.inventory.embeddedSha256Path
  $inventoryBytes = Get-EntryBytes $entries[$inventoryPath]
  $inventorySha256 = Get-BytesSha256 $inventoryBytes
  $inventoryShaText = [Text.Encoding]::ASCII.GetString((Get-EntryBytes $entries[$inventoryShaPath])).Trim()
  if ($inventoryShaText -ne "$inventorySha256  $inventoryPath") { throw 'Embedded current-source inventory SHA-256 sidecar is invalid.' }
  $inventory = [Text.Encoding]::UTF8.GetString($inventoryBytes) | ConvertFrom-Json
  if ($inventory.schema -ne 'orangefive.current-source-inventory.v1' -or $inventory.product -ne 'Orange' -or $inventory.release -ne 'OrangeFive' -or $inventory.snapshotKind -ne 'current-source') {
    throw 'Current-source inventory identity is invalid.'
  }
  if ($inventory.hashAlgorithm -ne 'sha256' -or $inventory.treeHashEncoding -ne 'utf8-lines-of-sha256-space-bytes-space-path-lf' -or $inventory.pathOrder -ne 'ordinal') {
    throw 'Current-source inventory hash contract is invalid.'
  }
  if ([bool]$inventory.cleanSourceRequired -and ($inventory.sourceControl.kind -ne 'git-clean-checkout' -or -not [bool]$inventory.sourceControl.clean)) {
    throw 'Current-source inventory claims a required clean source without clean Git provenance.'
  }
  $inventoryFiles = @($inventory.files)
  if ([int]$inventory.sourceFileCount -ne $inventoryFiles.Count -or $inventoryFiles.Count -ne ($lockedFiles.Count - 2)) { throw 'Current-source inventory file count is invalid.' }
  $inventoryPaths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $inventoryBytesTotal = [long]0
  foreach ($record in $inventoryFiles) {
    $recordPath = [string]$record.path
    Assert-SafeArchivePath $recordPath
    if (-not $inventoryPaths.Add($recordPath)) { throw "Current-source inventory contains a duplicate path: $recordPath" }
    if (-not $lockedByPath.ContainsKey($recordPath)) { throw "Current-source inventory path is not payload-locked: $recordPath" }
    $locked = $lockedByPath[$recordPath]
    if ([long]$record.bytes -ne [long]$locked.bytes -or [string]$record.sha256 -ne [string]$locked.sha256) { throw "Current-source inventory disagrees with payload lock: $recordPath" }
    $inventoryBytesTotal += [long]$record.bytes
  }
  if ($inventoryBytesTotal -ne [long]$inventory.sourceBytes) { throw 'Current-source inventory byte total is invalid.' }
  $sourceTreeSha256 = Get-TreeSha256 $inventoryFiles
  if ($sourceTreeSha256 -ne [string]$inventory.sourceTreeSha256) { throw 'Current-source inventory tree SHA-256 is invalid.' }

  $atomicOrangeFiles = @($inventoryFiles | Where-Object { ([string]$_.path).StartsWith('ATOMICORANGE/', [StringComparison]::Ordinal) })
  $atomicOrangeBytes = [long]0
  foreach ($record in $atomicOrangeFiles) { $atomicOrangeBytes += [long]$record.bytes }
  $atomicOrangeTreeSha256 = Get-TreeSha256 $atomicOrangeFiles
  if (
    $atomicOrangeFiles.Count -eq 0 -or
    [int]$inventory.atomicOrange.fileCount -ne $atomicOrangeFiles.Count -or
    [long]$inventory.atomicOrange.bytes -ne $atomicOrangeBytes -or
    [string]$inventory.atomicOrange.treeSha256 -ne $atomicOrangeTreeSha256
  ) {
    throw 'Atomic Orange source inventory proof is invalid.'
  }

  $contractMap = [ordered]@{
    sourcePackage = '00-CHARTER/LLM-DEPLOY/source-package-manifest.json'
    discoveryPlans = '00-CHARTER/LLM-DEPLOY/discovery-plans.json'
    lifecycle = '00-CHARTER/LLM-DEPLOY/lifecycle-manifest.json'
    rollback = '00-CHARTER/LLM-DEPLOY/rollback-manifest.json'
    modelAcquisition = '00-CHARTER/LLM-DEPLOY/model-acquisition-manifest.json'
  }
  foreach ($contractName in $contractMap.Keys) {
    $contractPath = [string]$contractMap[$contractName]
    $inventoryContract = $inventory.contracts.$contractName
    if ([string]$inventoryContract.path -ne $contractPath -or -not $lockedByPath.ContainsKey($contractPath) -or [string]$inventoryContract.sha256 -ne [string]$lockedByPath[$contractPath].sha256) {
      throw "Current-source contract hash proof is invalid: $contractName"
    }
  }

  $lifecycle = Get-EntryJson $entries $contractMap.lifecycle
  $requiredStates = @('SOURCE_VERIFIED', 'DISCOVERED', 'PLANNED', 'APPLYING', 'APPLIED', 'READY', 'BLOCKED', 'ROLLED_BACK')
  $stateIds = @($lifecycle.states | ForEach-Object { [string]$_.id })
  $applyTransitions = @($lifecycle.transitions | Where-Object { $_.from -eq 'PLANNED' -and $_.to -eq 'APPLYING' -and [bool]$_.requiresExactApprovalHashes })
  $rollbackTransitions = @($lifecycle.transitions | Where-Object { $_.to -eq 'ROLLED_BACK' -and $_.command -eq 'rollback' })
  if (
    $lifecycle.schema -ne 'orange.deploy.lifecycle-manifest.v1' -or
    @($requiredStates | Where-Object { $_ -notin $stateIds }).Count -gt 0 -or
    $applyTransitions.Count -eq 0 -or
    $rollbackTransitions.Count -eq 0 -or
    'package' -notin @($lifecycle.receipts) -or
    'rollback' -notin @($lifecycle.receipts)
  ) {
    throw 'Lifecycle manifest proof is invalid.'
  }

  $rollback = Get-EntryJson $entries $contractMap.rollback
  if (
    $rollback.schema -ne 'orange.deploy.rollback-manifest.v1' -or
    $rollback.actionOrder -ne 'reverse successful apply order' -or
    $rollback.result.status -ne 'ROLLED_BACK_DATA_PRESERVED' -or
    $rollback.result.postRollbackReadiness -ne 'ROLLED_BACK' -or
    @($rollback.actions).Count -eq 0 -or
    @($rollback.alwaysPreserved | Where-Object { [string]$_ -match '(?i)model' }).Count -eq 0
  ) {
    throw 'Rollback manifest proof is invalid.'
  }

  $modelAcquisition = Get-EntryJson $entries $contractMap.modelAcquisition
  if (
    $modelAcquisition.schema -ne 'orange.deploy.model-acquisition-manifest.v1' -or
    [bool]$modelAcquisition.payloadPolicy.modelWeightsIncluded -or
    [bool]$modelAcquisition.payloadPolicy.privateModelsIncluded -or
    -not [bool]$modelAcquisition.payloadPolicy.metadataOnly -or
    -not [bool]$modelAcquisition.claims.weightsExcludedFromSourceArchive
  ) {
    throw 'Model acquisition manifest does not prove metadata-only weight exclusion.'
  }

  $report = [ordered]@{
    schema = 'orangefive.source-package-verification.v1'
    status = 'VERIFIED'
    product = 'Orange'
    release = 'OrangeFive'
    zipPath = $ZipPath
    zipSha256 = $zipSha256
    archive = [ordered]@{
      entryCount = $entries.Count
      fixedTimestampUtc = '2000-01-01T00:00:00Z'
      allEntriesPayloadLocked = $true
    }
    payloadLock = [ordered]@{
      sha256 = Get-BytesSha256 (Get-EntryBytes $entries[$lockPath])
      fileCount = $lockedFiles.Count
    }
    inventory = [ordered]@{
      path = $inventoryPath
      sha256 = $inventorySha256
      sourceFileCount = $inventoryFiles.Count
      sourceBytes = $inventoryBytesTotal
      sourceTreeSha256 = $sourceTreeSha256
      cleanSourceRequired = [bool]$inventory.cleanSourceRequired
      sourceControl = $inventory.sourceControl
    }
    atomicOrange = [ordered]@{
      fileCount = $atomicOrangeFiles.Count
      bytes = $atomicOrangeBytes
      treeSha256 = $atomicOrangeTreeSha256
    }
    contracts = [ordered]@{
      lifecycle = [ordered]@{ verified = $true; sha256 = [string]$inventory.contracts.lifecycle.sha256 }
      rollback = [ordered]@{ verified = $true; sha256 = [string]$inventory.contracts.rollback.sha256 }
      modelAcquisition = [ordered]@{ verified = $true; sha256 = [string]$inventory.contracts.modelAcquisition.sha256; weightsExcluded = $true }
    }
    publishPerformed = $false
  }
  $report | ConvertTo-Json -Depth 12
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
