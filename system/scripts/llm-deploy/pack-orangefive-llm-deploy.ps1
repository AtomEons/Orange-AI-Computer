[CmdletBinding()]
param(
  [string]$SourceRoot = '',
  [string]$DestinationRoot = '',
  [switch]$DryRun,
  [switch]$SkipReleaseProof
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($SourceRoot)) { $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) { $DestinationRoot = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\packages' }

function Get-NormalizedFullPath([string]$Value) {
  return [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
}

function Test-ContainedPath([string]$Candidate, [string]$Parent) {
  $child = Get-NormalizedFullPath $Candidate
  $root = Get-NormalizedFullPath $Parent
  return $child.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Test-PayloadExclusion([string]$RelativePath) {
  $relative = $RelativePath.Replace('\', '/')
  $segments = @($relative.Split('/'))
  $leaf = $segments[-1]
  $excludedProductRoots = @('02-ATOMIC-ORANGE-V1', 'ATOMICORANGE', '19-ARCHIVE')
  $allowedRootFiles = @('.dockerignore', '.gitignore', 'ORANGE_START.cmd', 'ORANGEFIVE_CURRENT_OPERATIONAL_TRUTH.md', 'README.md', 'package.json')
  if ($segments[0] -in $excludedProductRoots) { return $true }
  if ($segments.Count -eq 1 -and $segments[0] -notin $allowedRootFiles) { return $true }
  if ($segments -contains '.git' -or $segments -contains 'node_modules' -or $segments -contains '.next' -or $segments -contains 'dist' -or $segments -contains 'out' -or $segments -contains 'target' -or $segments -contains '__pycache__' -or $segments -contains '.venv' -or $segments -contains 'venv') { return $true }
  if ($segments -contains '.fixtures') { return $true }
  if ($segments -contains '10-RECEIPTS' -or $segments -contains 'receipts' -or $segments -contains 'logs' -or $segments -contains 'runtime-data') { return $true }
  if ($segments -contains 'Orange3' -or $segments -contains 'Orange4') { return $true }
  if ($relative -match '(?i)^\.orange5-' -or $relative -match '(?i)(^|/)(\.latest\.cache|\.sync-state)\.json$') { return $true }
  if ($relative -match '(?i)^05-FLOW/state/' -or $relative -match '(?i)^06-ORANGELLM/n150-utility/.*/state/' -or $relative -match '(?i)^08-HERMES/(approvals|audit)/') { return $true }
  if ($relative -match '(?i)^01-DOCTRINE/27-guardrails/state/' -or $relative -match '(?i)^04-CONTROL-PLANE/session-start/state/') { return $true }
  if ($relative -match '(?i)^06-ORANGELLM/memory/cache/(atomic-orange-patch/|latest\.json$|shadow-meta\.json$)') { return $true }
  if ($relative -match '(?i)(^|/)(commerce|website-assets)(/|$)') { return $true }
  if ($leaf -match '(?i)^(\.env($|\.)|\.npmrc$|\.pypirc$|_netrc$|credentials$|id_(rsa|dsa|ecdsa|ed25519)$|authorized_keys$|known_hosts$|.*\.(pem|key|pfx|p12|db|sqlite|sqlite3|log|pid))$') { return $true }
  if ($leaf -match '(?i)\.(safetensors|gguf|ggml|ckpt|pt|pth|onnx)$') { return $true }
  if ($relative -match '(?i)(private-model|abliterated|credential|secret-token)') { return $true }
  if ($relative -eq 'orangefive.payload.lock.json') { return $true }
  return $false
}

function Find-HighConfidenceCredential([string]$Path) {
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -gt 8MB) { return $null }
  $extensions = @('.cmd', '.conf', '.config', '.ini', '.ipynb', '.js', '.json', '.md', '.mjs', '.ps1', '.py', '.sh', '.toml', '.ts', '.txt', '.yaml', '.yml')
  if ([IO.Path]::GetExtension($Path).ToLowerInvariant() -notin $extensions) { return $null }
  try { $text = [IO.File]::ReadAllText($Path) } catch { return $null }
  $privateKeyMarker = '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'
  $rsaKeyMarker = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
  if ($text.Contains($privateKeyMarker) -or $text.Contains($rsaKeyMarker)) { return 'private-key-material' }
  if ($text -match '(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])') { return 'aws-access-key' }
  if ($text -match '(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9])' -or $text -match '(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}(?![A-Za-z0-9])') { return 'github-token' }
  if ($text -match '(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{32,}(?![A-Za-z0-9])') { return 'openai-style-key' }
  if ($text -match '(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{20,}(?![A-Za-z0-9])') { return 'slack-token' }
  return $null
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Get-PublicArchiveFile(
  [object]$File,
  [string]$StageRoot,
  [object[]]$Redactions,
  [string]$SoulGenomeTemplate
) {
  $sourcePath = [string]$File.absolutePath
  $templateApplied = $false
  if ([string]$File.path -eq '13-MODELS/orange-llm/soul_genome.json') {
    $sourcePath = $SoulGenomeTemplate
    $templateApplied = $true
  }

  $textExtensions = @('.bat', '.cmd', '.conf', '.config', '.css', '.html', '.ini', '.ipynb', '.js', '.json', '.jsonl', '.md', '.mjs', '.ps1', '.py', '.sh', '.toml', '.ts', '.tsx', '.txt', '.yaml', '.yml')
  $extension = [IO.Path]::GetExtension($sourcePath).ToLowerInvariant()
  $archiveSource = $sourcePath
  $sanitized = $templateApplied
  if ($extension -in $textExtensions) {
    $text = [IO.File]::ReadAllText($sourcePath)
    $publicText = $text
    foreach ($redaction in $Redactions) {
      $from = [string]$redaction.from
      if (-not [string]::IsNullOrWhiteSpace($from)) {
        $publicText = $publicText.Replace($from, [string]$redaction.to)
      }
    }
    if ($publicText -ne $text -or $templateApplied) {
      $archiveSource = Join-Path $StageRoot ([string]$File.path)
      $parent = Split-Path -Parent $archiveSource
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
      [IO.File]::WriteAllText($archiveSource, $publicText, [Text.UTF8Encoding]::new($false))
      $sanitized = $true
    }
  }

  $item = Get-Item -LiteralPath $archiveSource
  return [pscustomobject][ordered]@{
    path = [string]$File.path
    absolutePath = $item.FullName
    bytes = [long]$item.Length
    sha256 = Get-Sha256 $item.FullName
    publicSanitized = $sanitized
    publicTemplate = $templateApplied
  }
}

function Get-PayloadSourceFiles([string]$Root) {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
  if ($git) {
    $relativeFiles = @(& $git.Source -C $Root ls-files --cached --others --exclude-standard)
    if ($LASTEXITCODE -eq 0) {
      foreach ($relative in $relativeFiles) {
        $normalized = ([string]$relative).Replace('\', '/')
        if (Test-PayloadExclusion $normalized) { continue }
        $full = Join-Path $Root ([string]$relative)
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $item = Get-Item -Force -LiteralPath $full
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse-point files are forbidden in the deploy payload: $normalized" }
        $item
      }
      return
    }
  }
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push($Root)
  while ($stack.Count -gt 0) {
    $directory = $stack.Pop()
    foreach ($item in Get-ChildItem -LiteralPath $directory -Force) {
      if (-not (Test-ContainedPath $item.FullName $Root)) { throw "Payload enumeration escaped source root: $($item.FullName)" }
      $relative = $item.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
      if ($item.PSIsContainer) {
        if (Test-PayloadExclusion ($relative + '/')) { continue }
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse-point directories are forbidden in the deploy payload: $relative" }
        $stack.Push($item.FullName)
      } elseif (-not (Test-PayloadExclusion $relative)) {
        $item
      }
    }
  }
}

function Assert-SourceSnapshot([object[]]$Expected, [string]$Root) {
  $current = @(Get-PayloadSourceFiles $Root | ForEach-Object {
    $relative = $_.FullName.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
    if (-not (Test-PayloadExclusion $relative)) {
      [pscustomobject][ordered]@{
        path = $relative
        bytes = [long]$_.Length
        sha256 = Get-Sha256 $_.FullName
      }
    }
  } | Sort-Object path)
  if ($current.Count -ne $Expected.Count) {
    throw "Source payload changed during packaging: expected $($Expected.Count) files, found $($current.Count)."
  }
  for ($index = 0; $index -lt $Expected.Count; $index++) {
    $before = $Expected[$index]
    $after = $current[$index]
    if ($before.path -ne $after.path -or [long]$before.bytes -ne [long]$after.bytes -or $before.sha256 -ne $after.sha256) {
      throw "Source payload changed during packaging: expected $($before.path), observed $($after.path)."
    }
  }
}

$SourceRoot = Get-NormalizedFullPath $SourceRoot
$DestinationRoot = Get-NormalizedFullPath $DestinationRoot
if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) { throw "Source root does not exist: $SourceRoot" }
if (Test-ContainedPath $DestinationRoot $SourceRoot) { throw 'ZIP output must live outside the immutable OrangeFive payload.' }

$manifestPath = Join-Path $SourceRoot '00-CHARTER\LLM-DEPLOY\orangefive.deploy.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Deploy manifest is missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schema -ne 'orange.deploy.manifest.v1' -or $manifest.product -ne 'Orange' -or $manifest.release -ne 'OrangeFive') {
  throw 'The packer accepts only the Orange release OrangeFive deploy manifest.'
}

$sourceFiles = @(Get-PayloadSourceFiles $SourceRoot | ForEach-Object {
  if (-not (Test-ContainedPath $_.FullName $SourceRoot)) { throw "Payload enumeration escaped source root: $($_.FullName)" }
  $relative = $_.FullName.Substring($SourceRoot.Length).TrimStart('\', '/').Replace('\', '/')
  if (-not (Test-PayloadExclusion $relative)) {
    if (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse-point files are forbidden in the deploy payload: $relative" }
    $credential = Find-HighConfidenceCredential $_.FullName
    if ($credential) { throw "Credential scan blocked $relative ($credential)." }
    [pscustomobject][ordered]@{
      path = $relative
      absolutePath = $_.FullName
      bytes = [long]$_.Length
      sha256 = Get-Sha256 $_.FullName
    }
  }
} | Sort-Object path)

$soulGenomeTemplate = Join-Path $SourceRoot '00-CHARTER\LLM-DEPLOY\soul-genome.public.json'
if (-not (Test-Path -LiteralPath $soulGenomeTemplate -PathType Leaf)) {
  throw "Public Soul Genome template is missing: $soulGenomeTemplate"
}
$privateGenomePath = Join-Path $SourceRoot '13-MODELS\orange-llm\soul_genome.json'
$privateGenome = if (Test-Path -LiteralPath $privateGenomePath -PathType Leaf) {
  Get-Content -LiteralPath $privateGenomePath -Raw | ConvertFrom-Json
} else { $null }
$redactions = @(
  [pscustomobject]@{ from = $env:USERPROFILE; to = '%USERPROFILE%' },
  [pscustomobject]@{ from = $env:USERPROFILE.Replace('\', '/'); to = '%USERPROFILE%' },
  [pscustomobject]@{ from = [string]$privateGenome.sovereign.email; to = 'operator@example.invalid' },
  [pscustomobject]@{ from = [string]$privateGenome.location.city; to = 'Operator locality' }
)
$stageRoot = Join-Path ([IO.Path]::GetTempPath()) ("orange-public-pack-$PID-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stageRoot | Out-Null
$files = @($sourceFiles | ForEach-Object {
  Get-PublicArchiveFile -File $_ -StageRoot $stageRoot -Redactions $redactions -SoulGenomeTemplate $soulGenomeTemplate
} | Sort-Object path)
$sanitizedFileCount = @($files | Where-Object { $_.publicSanitized }).Count
$templateFileCount = @($files | Where-Object { $_.publicTemplate }).Count

$required = @(
  'ORANGE_START.cmd',
  '00-CHARTER/LLM-DEPLOY/INSTALL_ORANGE.md',
  '00-CHARTER/LLM-DEPLOY/orangefive.deploy.json',
  '00-CHARTER/LLM-DEPLOY/model-acquisition-catalog.json',
  'scripts/llm-deploy/orange-deploy.mjs',
  'scripts/llm-deploy/deploy-core.mjs',
  'scripts/llm-deploy/deploy-probes.mjs',
  'scripts/llm-deploy/deploy-runtime.mjs'
  'scripts/llm-deploy/deploy-downloads.mjs'
  'scripts/llm-deploy/deploy-clients.mjs'
  'scripts/llm-deploy/pack-orangefive-llm-deploy.ps1'
  'scripts/llm-deploy/prove-orangefive-llm-deploy.mjs'
)
$included = @($files | ForEach-Object { $_.path })
$missing = @($required | Where-Object { $_ -notin $included })
if ($missing.Count) { throw "Required deploy payload files are missing: $($missing -join ', ')" }
$payloadBytes = [long]0
foreach ($file in $files) { $payloadBytes += [long]$file.bytes }

$payloadLock = [ordered]@{
  schema = 'orangefive.payload-lock.v1'
  product = 'Orange'
  release = 'OrangeFive'
  hashAlgorithm = 'sha256'
  fileCount = $files.Count
  files = @($files | ForEach-Object { [ordered]@{ path = $_.path; bytes = $_.bytes; sha256 = $_.sha256 } })
}
$lockJson = ($payloadLock | ConvertTo-Json -Depth 8) + "`n"
$zipPath = Join-Path $DestinationRoot 'OrangeFive-LLM-deploy.zip'

$plan = [ordered]@{
  schema = 'orangefive.deploy-pack-plan.v1'
  mode = if ($DryRun) { 'dry-run' } else { 'apply' }
  sourceRoot = $SourceRoot
  destination = $zipPath
  fileCount = $files.Count
  payloadBytes = $payloadBytes
  embeddedLock = 'orangefive.payload.lock.json'
  credentialScan = 'passed'
  publicSanitization = [ordered]@{
    filesTransformed = $sanitizedFileCount
    operatorGenomeTemplates = $templateFileCount
  }
  excluded = @($manifest.excluded)
}
if ($DryRun) {
  $plan | ConvertTo-Json -Depth 8
  [IO.Directory]::Delete($stageRoot, $true)
  exit 0
}

New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$temporaryZip = "$zipPath.$PID.partial"
if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip -Force }
try {
$stream = [IO.File]::Open($temporaryZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
$fixedTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
$archiveError = $null
try {
  foreach ($file in $files) {
    $entry = $archive.CreateEntry([string]$file.path, [IO.Compression.CompressionLevel]::Optimal)
    $entry.LastWriteTime = $fixedTime
    try { $input = [IO.File]::OpenRead([string]$file.absolutePath) }
    catch { throw "Source changed after payload inventory: $($file.path)" }
    $output = $entry.Open()
    try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
  }
  $lockEntry = $archive.CreateEntry('orangefive.payload.lock.json', [IO.Compression.CompressionLevel]::Optimal)
  $lockEntry.LastWriteTime = $fixedTime
  $writer = [IO.StreamWriter]::new($lockEntry.Open(), [Text.UTF8Encoding]::new($false))
  try { $writer.Write($lockJson) } finally { $writer.Dispose() }
} catch {
  $archiveError = $_
} finally {
  $archive.Dispose()
  $stream.Dispose()
}
if ($archiveError) {
  if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip -Force }
  throw $archiveError
}

$verifyStream = [IO.File]::OpenRead($temporaryZip)
$verifyArchive = [IO.Compression.ZipArchive]::new($verifyStream, [IO.Compression.ZipArchiveMode]::Read, $false, [Text.Encoding]::UTF8)
$verificationError = $null
try {
  $entries = @($verifyArchive.Entries)
  if ($entries.Count -ne ($files.Count + 1)) { throw "ZIP verification count mismatch: expected $($files.Count + 1), got $($entries.Count)" }
  if (@($entries.FullName | Sort-Object -Unique).Count -ne $entries.Count) { throw 'ZIP verification found duplicate entry names.' }
  foreach ($requiredPath in $required) {
    if ($requiredPath -notin @($entries.FullName)) { throw "ZIP verification is missing required entry: $requiredPath" }
  }
  $embedded = $verifyArchive.GetEntry('orangefive.payload.lock.json')
  if (-not $embedded) { throw 'ZIP verification is missing the embedded payload lock.' }
  $reader = [IO.StreamReader]::new($embedded.Open(), [Text.Encoding]::UTF8)
  try { $verifiedLock = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  if ($verifiedLock.schema -ne 'orangefive.payload-lock.v1' -or $verifiedLock.product -ne 'Orange' -or $verifiedLock.release -ne 'OrangeFive' -or $verifiedLock.hashAlgorithm -ne 'sha256') {
    throw 'Embedded payload lock identity verification failed.'
  }
  $lockFiles = @($verifiedLock.files)
  if ([int]$verifiedLock.fileCount -ne $files.Count -or $lockFiles.Count -ne $files.Count) { throw 'Embedded payload lock count verification failed.' }
  $lockNames = @($lockFiles | ForEach-Object { [string]$_.path })
  if (@($lockNames | Sort-Object -Unique).Count -ne $lockNames.Count) { throw 'Embedded payload lock contains duplicate paths.' }
  foreach ($record in $lockFiles) {
    $recordPath = ([string]$record.path).Replace('\', '/')
    if ([string]::IsNullOrWhiteSpace($recordPath) -or [IO.Path]::IsPathRooted($recordPath) -or $recordPath.Split('/') -contains '..') {
      throw "Embedded payload lock contains an unsafe path: $recordPath"
    }
    if ([string]$record.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$record.bytes -lt 0) {
      throw "Embedded payload lock contains invalid checksum metadata: $recordPath"
    }
    $entry = $verifyArchive.GetEntry($recordPath)
    if (-not $entry) { throw "ZIP verification is missing locked entry: $recordPath" }
    if ([long]$entry.Length -ne [long]$record.bytes) { throw "ZIP verification byte mismatch: $recordPath" }
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $input = $entry.Open()
    try { $actual = ([BitConverter]::ToString($algorithm.ComputeHash($input)) -replace '-', '').ToLowerInvariant() }
    finally { $input.Dispose(); $algorithm.Dispose() }
    if ($actual -ne [string]$record.sha256) { throw "ZIP verification SHA-256 mismatch: $recordPath" }
  }
} catch {
  $verificationError = $_
} finally {
  $verifyArchive.Dispose()
  $verifyStream.Dispose()
}
if ($verificationError) {
  if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip -Force }
  throw $verificationError
}
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Move-Item -LiteralPath $temporaryZip -Destination $zipPath
} catch {
  if (Test-Path -LiteralPath $temporaryZip) { Remove-Item -LiteralPath $temporaryZip -Force }
  throw
}

$zipSha256 = Get-Sha256 $zipPath
Set-Content -LiteralPath "$zipPath.sha256" -Value "$zipSha256  OrangeFive-LLM-deploy.zip" -Encoding ascii
$proofReceiptPath = Join-Path $DestinationRoot 'OrangeFive-LLM-deploy.proof.json'
$proofStatus = 'SKIPPED_BY_EXPLICIT_SWITCH'
$proofReceiptSha256 = $null
if (-not $SkipReleaseProof) {
  try {
    $bun = Get-Command bun.exe -ErrorAction SilentlyContinue
    if (-not $bun) { $bun = Get-Command bun -ErrorAction SilentlyContinue }
    if (-not $bun) { throw 'Bun is required to run the extracted OrangeFive release proof.' }
    $proofScript = Join-Path $SourceRoot 'scripts\llm-deploy\prove-orangefive-llm-deploy.mjs'
    $proofOutput = (& $bun.Source $proofScript --zip $zipPath --receipt $proofReceiptPath | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Extracted release proof failed: $proofOutput" }
    $proof = $proofOutput | ConvertFrom-Json
    if ($proof.status -ne 'PROVEN' -or -not $proof.safeTemporaryRoot.removed) { throw 'Extracted release proof did not return a clean PROVEN receipt.' }
    $proofStatus = [string]$proof.status
    $proofReceiptSha256 = Get-Sha256 $proofReceiptPath
  } catch {
    if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
    if (Test-Path -LiteralPath "$zipPath.sha256") { Remove-Item -LiteralPath "$zipPath.sha256" -Force }
    throw
  }
}
# The extracted proof can take minutes. Re-hash the source after it finishes so
# a concurrent edit cannot leave a valid but already-stale release archive.
Assert-SourceSnapshot -Expected $sourceFiles -Root $SourceRoot
$reportPath = Join-Path $DestinationRoot 'OrangeFive-LLM-deploy.report.json'
$report = [ordered]@{
  schema = 'orangefive.deploy-pack-report.v1'
  status = 'PACKED'
  product = 'Orange'
  release = 'OrangeFive'
  zipPath = $zipPath
  zipSha256 = $zipSha256
  sidecarPath = "$zipPath.sha256"
  fileCount = $files.Count
  payloadBytes = $payloadBytes
  credentialScan = 'passed'
  publicSanitization = [ordered]@{
    filesTransformed = $sanitizedFileCount
    operatorGenomeTemplates = $templateFileCount
  }
  archiveVerification = 'passed'
  archiveVerificationMode = 'entry-count-path-size-sha256'
  sourceSnapshotVerified = $true
  extractedReleaseProof = $proofStatus
  proofReceiptPath = if ($SkipReleaseProof) { $null } else { $proofReceiptPath }
  proofReceiptSha256 = $proofReceiptSha256
  receiptPath = $reportPath
}
$report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $reportPath -Encoding utf8
$report | ConvertTo-Json -Depth 8
[IO.Directory]::Delete($stageRoot, $true)
