[CmdletBinding()]
param(
  [string]$RepositoryRoot = '',
  [string]$DestinationRoot = '',
  [string]$Ref = 'HEAD',
  [switch]$SkipReleaseProof
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedFullPath([string]$Value) {
  return [IO.Path]::GetFullPath($Value).TrimEnd('\', '/')
}

function Test-ContainedPath([string]$Candidate, [string]$Parent) {
  $child = Get-NormalizedFullPath $Candidate
  $root = Get-NormalizedFullPath $Parent
  return $child.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or $child.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Packer([string]$Script, [string]$Source, [string]$Destination, [string]$Commit, [bool]$SkipProof) {
  $arguments = @(
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Script,
    '-SourceRoot', $Source,
    '-DestinationRoot', $Destination,
    '-RequireCleanSource',
    '-ExpectedCommit', $Commit
  )
  if ($SkipProof) { $arguments += '-SkipReleaseProof' }
  $output = (& powershell.exe @arguments 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw "Clean-clone packer failed: $output" }
  try { return $output | ConvertFrom-Json }
  catch { throw "Clean-clone packer returned invalid JSON: $output" }
}

if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) { $RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path }
if ([string]::IsNullOrWhiteSpace($DestinationRoot)) { $DestinationRoot = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\packages' }
$RepositoryRoot = Get-NormalizedFullPath $RepositoryRoot
$DestinationRoot = Get-NormalizedFullPath $DestinationRoot
if (-not (Test-Path -LiteralPath $RepositoryRoot -PathType Container)) { throw "Repository root does not exist: $RepositoryRoot" }
if (Test-ContainedPath $DestinationRoot $RepositoryRoot) { throw 'Clean-clone package output must be outside the source repository.' }

$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { $git = Get-Command git -ErrorAction SilentlyContinue }
if (-not $git) { throw 'Git is required for clean-clone current-source packaging.' }
$topLevel = (& $git.Source -C $RepositoryRoot rev-parse --show-toplevel 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or (Get-NormalizedFullPath $topLevel) -ne $RepositoryRoot) { throw 'RepositoryRoot must be the top level of a Git worktree.' }
$sourceStatus = @(& $git.Source -C $RepositoryRoot status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect source repository cleanliness.' }
if ($sourceStatus.Count -ne 0) { throw 'Current-source packaging requires a clean source repository before cloning.' }
$commit = (& $git.Source -C $RepositoryRoot rev-parse --verify "$Ref^{commit}" | Out-String).Trim().ToLowerInvariant()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40,64}$') { throw "Unable to resolve source ref to a commit: $Ref" }

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ("orangefive-clean-clone-pack-$PID-" + [guid]::NewGuid().ToString('N'))
$cloneRoot = Join-Path $temporaryRoot 'clone'
$repeatRoot = Join-Path $temporaryRoot 'repeat'
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
$finalReport = $null
try {
  & $git.Source clone --no-hardlinks --no-checkout --no-tags --quiet -- $RepositoryRoot $cloneRoot
  if ($LASTEXITCODE -ne 0) { throw 'Unable to create isolated local clone for current-source packaging.' }
  & $git.Source -C $cloneRoot config core.autocrlf false
  if ($LASTEXITCODE -ne 0) { throw 'Unable to normalize clean-clone line ending configuration.' }
  & $git.Source -C $cloneRoot config core.eol lf
  if ($LASTEXITCODE -ne 0) { throw 'Unable to normalize clean-clone line ending configuration.' }
  & $git.Source -C $cloneRoot checkout --quiet --detach $commit
  if ($LASTEXITCODE -ne 0) { throw "Unable to check out clean-clone commit: $commit" }
  $cloneStatus = @(& $git.Source -C $cloneRoot status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $cloneStatus.Count -ne 0) { throw 'Detached packaging clone is not clean.' }

  $sourceRoot = Join-Path $cloneRoot 'system'
  $packerPath = Join-Path $sourceRoot 'scripts\llm-deploy\pack-orangefive-llm-deploy.ps1'
  if (-not (Test-Path -LiteralPath $packerPath -PathType Leaf)) { throw 'The selected commit does not contain the OrangeFive source packer.' }
  $sourcePackageManifestPath = Join-Path $sourceRoot '00-CHARTER\LLM-DEPLOY\source-package-manifest.json'
  $sourcePackageManifest = Get-Content -LiteralPath $sourcePackageManifestPath -Raw | ConvertFrom-Json
  $cleanCloneReportName = [string]$sourcePackageManifest.archive.cleanCloneReportName
  if (-not $cleanCloneReportName.StartsWith('Orange-AI-Computer-Wave-4A-Green', [StringComparison]::Ordinal)) { throw 'Clean-clone report name violates the public naming contract.' }
  New-Item -ItemType Directory -Force -Path $DestinationRoot | Out-Null
  $first = Invoke-Packer $packerPath $sourceRoot $DestinationRoot $commit ([bool]$SkipReleaseProof)
  $second = Invoke-Packer $packerPath $sourceRoot $repeatRoot $commit $true
  if ($first.zipSha256 -ne $second.zipSha256 -or $first.inventorySha256 -ne $second.inventorySha256 -or $first.sourceTreeSha256 -ne $second.sourceTreeSha256) {
    throw 'Current-source packaging was not deterministic across repeated clean-clone builds.'
  }
  $postPackageStatus = @(& $git.Source -C $cloneRoot status --porcelain=v1 --untracked-files=all)
  if ($LASTEXITCODE -ne 0 -or $postPackageStatus.Count -ne 0) { throw 'Current-source packaging mutated the detached clean clone.' }

  $reportPath = Join-Path $DestinationRoot $cleanCloneReportName
  $finalReport = [ordered]@{
    schema = 'orangefive.clean-clone-package-report.v1'
    status = 'VERIFIED'
    product = 'Orange'
    release = 'OrangeFive'
    source = [ordered]@{
      ref = $Ref
      commit = $commit
      cloneMethod = 'local-no-hardlinks-detached'
      lineEndings = 'git-core-autocrlf-false-core-eol-lf'
      cleanBeforePackaging = $true
      cleanAfterPackaging = $true
    }
    deterministicRepeat = [ordered]@{
      verified = $true
      zipSha256 = [string]$first.zipSha256
      inventorySha256 = [string]$first.inventorySha256
      sourceTreeSha256 = [string]$first.sourceTreeSha256
    }
    package = [ordered]@{
      zipPath = [string]$first.zipPath
      reportPath = [string]$first.receiptPath
      sourceVerificationPath = [string]$first.sourceVerificationPath
      releaseProofStatus = [string]$first.extractedReleaseProof
    }
    publishPerformed = $false
    receiptPath = $reportPath
  }
  $reportJson = (($finalReport | ConvertTo-Json -Depth 10) -replace "`r`n", "`n") + "`n"
  [IO.File]::WriteAllText($reportPath, $reportJson, [Text.UTF8Encoding]::new($false))
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) { [IO.Directory]::Delete($temporaryRoot, $true) }
}

$finalReport | ConvertTo-Json -Depth 10
