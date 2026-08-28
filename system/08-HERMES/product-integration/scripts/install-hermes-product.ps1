[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$InstallRoot = 'C:\AtomEons\ai-box\hermes-product',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$AllowedRoot = 'C:\AtomEons',
  [string]$WorkspaceRoot = 'C:\AtomEons\ai-box\workspaces',
  [string]$OrangeModelUrl = 'http://127.0.0.1:1337/v1',
  [string]$OrangeMcpUrl = 'http://127.0.0.1:7431/mcp',
  [ValidateSet('Auto', 'Compact', 'Balanced', 'Codexa')]
  [string]$SwarmProfile = 'Auto',
  [string]$PythonPath = '',
  [string]$ExistingHermesExe = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$Lock = Get-Content -LiteralPath (Join-Path $PackRoot 'upstream.lock.json') -Raw | ConvertFrom-Json
$ManifestPath = Join-Path $InstallRoot 'install-manifest.json'
$Venv = Join-Path $InstallRoot 'venv'
$HermesExe = Join-Path $Venv 'Scripts\hermes.exe'

function Resolve-ContainedPath([string]$Path, [string]$Base, [string]$Label, [bool]$AllowBase = $false) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $baseFull = [IO.Path]::GetFullPath($Base).TrimEnd('\')
  $isBase = $full -eq $baseFull
  if ((-not $AllowBase -and $isBase) -or (-not $isBase -and -not $full.StartsWith($baseFull + '\', [StringComparison]::OrdinalIgnoreCase))) {
    throw "$Label must be a child of allowed root $baseFull; got $full"
  }

  if (-not (Test-Path -LiteralPath $baseFull)) { throw "$Label base does not exist: $baseFull" }
  $resolvedBase = (Resolve-Path -LiteralPath $baseFull).ProviderPath.TrimEnd('\')
  $cursor = $full
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -Force -LiteralPath $cursor
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $cursor"
      }
      $resolved = (Resolve-Path -LiteralPath $cursor).ProviderPath.TrimEnd('\')
      $resolvedIsBase = $resolved -eq $resolvedBase
      if (-not $resolvedIsBase -and -not $resolved.StartsWith($resolvedBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label escapes its resolved root: $resolved"
      }
    }
    if ($cursor -eq $baseFull) { break }
    $parent = [IO.Directory]::GetParent($cursor)
    if (-not $parent) { throw "$Label has no safe ancestor under $baseFull" }
    $cursor = $parent.FullName.TrimEnd('\')
  }
  return $full
}

function Resolve-Python {
  if ($PythonPath) {
    if (-not (Test-Path -LiteralPath $PythonPath)) { throw "Python not found: $PythonPath" }
    return (Resolve-Path -LiteralPath $PythonPath).Path
  }
  $candidate = Get-Command python.exe -ErrorAction SilentlyContinue
  if (-not $candidate) { throw 'Python 3.11-3.13 is required. Install it explicitly, then rerun with -PythonPath.' }
  return $candidate.Source
}

function Resolve-ReadOnlyExecutable([string]$Path, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "$Label not found: $full" }
  $cursor = $full
  while ($cursor) {
    $item = Get-Item -Force -LiteralPath $cursor
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label path contains a reparse point: $cursor"
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if (-not $parent) { break }
    $cursor = $parent.FullName
  }
  return (Resolve-Path -LiteralPath $full).ProviderPath
}

function Resolve-TagCommit {
  $ref = Invoke-RestMethod -Uri $Lock.tagRefApi -Method Get -Headers @{ 'User-Agent' = 'OrangeFive-Hermes-Installer' }
  if ($ref.object.type -ne 'tag') { throw "Pinned release must remain an annotated tag; got $($ref.object.type)" }
  if ([string]$ref.object.sha -ne [string]$Lock.tagObjectSha) {
    throw "Pinned tag object moved. Expected $($Lock.tagObjectSha), got $($ref.object.sha)."
  }
  $tag = Invoke-RestMethod -Uri $ref.object.url -Method Get -Headers @{ 'User-Agent' = 'OrangeFive-Hermes-Installer' }
  if ($tag.object.type -ne 'commit') { throw "Tag does not resolve to a commit: $($tag.object.type)" }
  return [ordered]@{ tagObjectSha = [string]$ref.object.sha; commit = [string]$tag.object.sha }
}

$plan = [ordered]@{
  schema = 'orange5.hermes-install-plan.v1'
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  installRoot = $InstallRoot
  dataRoot = $DataRoot
  upstreamVersion = $Lock.packageVersion
  upstreamTag = $Lock.tag
  upstreamCommit = $Lock.commit
  source = "$($Lock.repository)@$($Lock.commit)"
  existingHermesExe = if ($ExistingHermesExe) { [IO.Path]::GetFullPath($ExistingHermesExe) } else { $null }
  installMode = if ($ExistingHermesExe) { 'adopt-verified-executable' } else { 'pinned-source-uv-lock' }
  dependencyMode = 'upstream-uv-lock-required'
  installExtras = @('mcp')
  startsService = $false
  restartsService = $false
  telemetry = $false
}

if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 8
  exit 0
}

$InstallRoot = Resolve-ContainedPath $InstallRoot $AllowedRoot 'InstallRoot'
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
$InstallRoot = Resolve-ContainedPath $InstallRoot $AllowedRoot 'InstallRoot'
$DataRoot = Resolve-ContainedPath $DataRoot $InstallRoot 'DataRoot'
$WorkspaceRoot = Resolve-ContainedPath $WorkspaceRoot $AllowedRoot 'WorkspaceRoot'
$ManifestPath = Join-Path $InstallRoot 'install-manifest.json'
$Venv = Resolve-ContainedPath (Join-Path $InstallRoot 'venv') $InstallRoot 'Venv'
$HermesExe = Join-Path $Venv 'Scripts\hermes.exe'

if ($ExistingHermesExe) {
  $HermesExe = Resolve-ReadOnlyExecutable $ExistingHermesExe 'ExistingHermesExe'
  $versionOutput = (& $HermesExe --version 2>&1 | Out-String).Trim()
  if ($versionOutput -notmatch "(?<![0-9])$([regex]::Escape([string]$Lock.packageVersion))(?![0-9])") {
    throw "Existing Hermes executable is not pinned version $($Lock.packageVersion): $versionOutput"
  }
  $binarySha256 = (Get-FileHash -LiteralPath $HermesExe -Algorithm SHA256).Hash.ToLowerInvariant()
  $adoptionChanged = $true
  if (Test-Path -LiteralPath $ManifestPath) {
    $previous = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    $adoptionChanged = -not ($previous.version -eq $Lock.packageVersion -and $previous.binarySha256 -eq $binarySha256 -and $previous.hermesExecutable -eq $HermesExe)
  }
  [ordered]@{
    schema = 'orange5.hermes-install-manifest.v1'
    package = $Lock.package
    version = $Lock.packageVersion
    tag = $Lock.tag
    tagObjectSha = $Lock.tagObjectSha
    pinCommit = $Lock.commit
    commit = $null
    sourceCommitVerified = $false
    provenanceMode = 'adopted-executable'
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    hermesExecutable = $HermesExe
    binarySha256 = $binarySha256
    versionEvidence = $versionOutput
    telemetry = $false
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding utf8

  $materializer = Join-Path $PSScriptRoot 'materialize-config.ps1'
  $materialized = & $materializer -Apply -DataRoot $DataRoot -WorkspaceRoot $WorkspaceRoot -AllowedRoot $AllowedRoot -OrangeModelUrl $OrangeModelUrl -OrangeMcpUrl $OrangeMcpUrl -SwarmProfile $SwarmProfile | ConvertFrom-Json
  [ordered]@{
    schema = 'orange5.hermes-install-report.v1'
    status = 'ADOPTED_NOT_RUNNING'
    changed = $adoptionChanged
    version = $Lock.packageVersion
    executable = $HermesExe
    binarySha256 = $binarySha256
    provenance = 'version-and-binary-hash; source commit not claimed'
    dataRoot = $DataRoot
    materialization = $materialized.status
    serviceStarted = $false
    nextAction = 'Run scripts/preflight.ps1, then start exactly one default gateway.'
  } | ConvertTo-Json -Depth 8
  exit 0
}

$python = Resolve-Python
$pythonVersion = (& $python -c 'import json,sys; print(json.dumps(list(sys.version_info[:3])))') | ConvertFrom-Json
if ($pythonVersion[0] -ne 3 -or $pythonVersion[1] -lt 11 -or $pythonVersion[1] -ge 14) {
  throw "Unsupported Python version: $($pythonVersion -join '.'). Hermes requires Python >=3.11,<3.14."
}

$resolvedTag = Resolve-TagCommit
if ($resolvedTag.commit -ne $Lock.commit) {
  throw "Pinned tag moved or upstream verification failed. Expected $($Lock.commit), got $($resolvedTag.commit)."
}

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { throw 'Git is required so the pinned commit object can be verified. No source archive fallback is allowed.' }
$uv = Get-Command uv.exe -ErrorAction SilentlyContinue
if (-not $uv) { throw 'uv is required so upstream uv.lock and package hashes are enforced. Install uv explicitly, then rerun.' }

$existingVersion = $null
if (Test-Path -LiteralPath $HermesExe) {
  $existingVersion = & (Join-Path $Venv 'Scripts\python.exe') -c "import importlib.metadata as m; print(m.version('hermes-agent'))" 2>$null
}

$needsInstall = $true
if ((Test-Path -LiteralPath $ManifestPath) -and $existingVersion -eq $Lock.packageVersion) {
  $installed = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
  if ($installed.commit -eq $Lock.commit) { $needsInstall = $false }
}

if ($needsInstall) {
  $source = Resolve-ContainedPath (Join-Path $InstallRoot 'source') $InstallRoot 'Source'
  if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
    if (Test-Path -LiteralPath $source) { throw "Unmanaged source directory already exists: $source" }
    & $git.Source clone --filter=blob:none --no-checkout $Lock.repository $source
    if ($LASTEXITCODE -ne 0) { throw "Hermes git clone failed with exit code $LASTEXITCODE" }
  } else {
    $origin = (& $git.Source -C $source remote get-url origin | Out-String).Trim().TrimEnd('/')
    if ($origin -ne $Lock.repository.TrimEnd('/')) { throw "Unexpected Hermes origin: $origin" }
    & $git.Source -C $source diff --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Managed Hermes source has local changes; refusing to overwrite it.' }
  }
  & $git.Source -C $source fetch --depth=1 origin $Lock.commit
  if ($LASTEXITCODE -ne 0) { throw "Hermes commit fetch failed with exit code $LASTEXITCODE" }
  & $git.Source -C $source checkout --detach $Lock.commit
  if ($LASTEXITCODE -ne 0) { throw "Hermes commit checkout failed with exit code $LASTEXITCODE" }
  $head = (& $git.Source -C $source rev-parse HEAD | Out-String).Trim()
  if ($head -ne $Lock.commit) { throw "Git object verification failed. Expected $($Lock.commit), got $head" }
  if (-not (Test-Path -LiteralPath (Join-Path $source 'uv.lock'))) { throw 'Pinned upstream source is missing uv.lock.' }

  $oldUvProjectEnvironment = $env:UV_PROJECT_ENVIRONMENT
  $env:UV_PROJECT_ENVIRONMENT = $Venv
  try {
    & $uv.Source sync --project $source --locked --extra mcp --no-dev --python $python
  } finally {
    $env:UV_PROJECT_ENVIRONMENT = $oldUvProjectEnvironment
  }
  if ($LASTEXITCODE -ne 0) { throw "Hermes locked uv sync failed with exit code $LASTEXITCODE" }
  $venvPython = Join-Path $Venv 'Scripts\python.exe'
  $installedVersion = & $venvPython -c "import importlib.metadata as m; print(m.version('hermes-agent'))"
  if ($installedVersion -ne $Lock.packageVersion) { throw "Installed $installedVersion, expected $($Lock.packageVersion)" }
  $Venv = Resolve-ContainedPath $Venv $InstallRoot 'Venv'
  [ordered]@{
    schema = 'orange5.hermes-install-manifest.v1'
    package = $Lock.package
    version = $installedVersion
    tag = $Lock.tag
    tagObjectSha = $Lock.tagObjectSha
    commit = $Lock.commit
    pinCommit = $Lock.commit
    sourceCommitVerified = $true
    provenanceMode = 'pinned-source-uv-lock'
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    python = $python
    dependencyLock = (Join-Path $source 'uv.lock')
    hermesExecutable = $HermesExe
    binarySha256 = (Get-FileHash -LiteralPath $HermesExe -Algorithm SHA256).Hash.ToLowerInvariant()
    telemetry = $false
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
}

$materializer = Join-Path $PSScriptRoot 'materialize-config.ps1'
$materialized = & $materializer -Apply -DataRoot $DataRoot -WorkspaceRoot $WorkspaceRoot -AllowedRoot $AllowedRoot -OrangeModelUrl $OrangeModelUrl -OrangeMcpUrl $OrangeMcpUrl -SwarmProfile $SwarmProfile | ConvertFrom-Json

[ordered]@{
  schema = 'orange5.hermes-install-report.v1'
  status = 'INSTALLED_NOT_RUNNING'
  changed = $needsInstall
  version = $Lock.packageVersion
  commit = $Lock.commit
  hermes = $HermesExe
  dataRoot = $DataRoot
  materialization = $materialized.status
  serviceStarted = $false
  nextAction = "Run scripts/preflight.ps1, then start exactly one gateway with HERMES_HOME=$DataRoot\.hermes."
} | ConvertTo-Json -Depth 8
