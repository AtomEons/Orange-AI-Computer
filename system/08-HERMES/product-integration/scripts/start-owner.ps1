[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$InstallRoot = 'C:\AtomEons\ai-box\hermes-product',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$WorkspaceRoot = 'C:\AtomEons\ai-box\workspaces',
  [string]$AllowedRoot = 'C:\AtomEons'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label contains a reparse point: $cursor" }
      $resolved = (Resolve-Path -LiteralPath $cursor).ProviderPath.TrimEnd('\')
      if ($resolved -ne $resolvedBase -and -not $resolved.StartsWith($resolvedBase + '\', [StringComparison]::OrdinalIgnoreCase)) {
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

$plannedManifest = Join-Path $InstallRoot 'install-manifest.json'
$plannedInstalled = if (Test-Path -LiteralPath $plannedManifest) { Get-Content -LiteralPath $plannedManifest -Raw | ConvertFrom-Json } else { $null }
$plannedExe = if ($plannedInstalled -and $plannedInstalled.hermesExecutable) { [string]$plannedInstalled.hermesExecutable } else { Join-Path $InstallRoot 'venv\Scripts\hermes.exe' }

$plan = [ordered]@{
  schema = 'orange5.hermes-gateway-start-plan.v1'
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  executable = $plannedExe
  hermesHome = (Join-Path $DataRoot '.hermes')
  cwd = $WorkspaceRoot
  window = 'hidden'
  gatewayCount = 1
  namedProfileGateways = 0
  arguments = @('gateway', 'run', '--external-supervisor')
}
if (-not $Apply) { $plan | ConvertTo-Json -Depth 6; exit 0 }

$InstallRoot = Resolve-ContainedPath $InstallRoot $AllowedRoot 'InstallRoot'
$DataRoot = Resolve-ContainedPath $DataRoot $InstallRoot 'DataRoot'
$WorkspaceRoot = Resolve-ContainedPath $WorkspaceRoot $AllowedRoot 'WorkspaceRoot'
$HermesHome = Resolve-ContainedPath (Join-Path $DataRoot '.hermes') $DataRoot 'HermesHome'
$InstallManifest = Resolve-ContainedPath (Join-Path $InstallRoot 'install-manifest.json') $InstallRoot 'InstallManifest'
$Installed = if (Test-Path -LiteralPath $InstallManifest) { Get-Content -LiteralPath $InstallManifest -Raw | ConvertFrom-Json } else { $null }
$HermesExe = if ($Installed -and $Installed.hermesExecutable) { [string]$Installed.hermesExecutable } else { Join-Path $InstallRoot 'venv\Scripts\hermes.exe' }
$LaunchManifest = Join-Path $DataRoot 'gateway-launch.json'
$LogRoot = Join-Path $DataRoot 'logs'
$WrapperPath = Join-Path $DataRoot 'gateway-owner.cmd'

if (-not (Test-Path -LiteralPath $HermesExe)) { throw "Hermes is not installed: $HermesExe" }
if (-not $Installed) { throw "Install manifest is missing: $InstallManifest" }
$expectedBinaryHash = if ($Installed.PSObject.Properties['binarySha256']) { [string]$Installed.binarySha256 } else { '' }
$actualBinaryHash = (Get-FileHash -LiteralPath $HermesExe -Algorithm SHA256).Hash.ToLowerInvariant()
if (-not $expectedBinaryHash -or $actualBinaryHash -ne $expectedBinaryHash) { throw "Hermes executable hash does not match the adopted/installed manifest." }
if (-not (Test-Path -LiteralPath (Join-Path $HermesHome 'config.yaml'))) { throw "Owner config is missing: $HermesHome\config.yaml" }
$existing = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine -match '(?i)hermes(?:\.exe)?["'']?\s+gateway\s+run(?:\s|$)' -or
    $_.CommandLine -match '(?i)gateway-owner\.cmd(?:"|\s|$)'
  )
})
if ($existing.Count) { throw "Refusing to start a duplicate Hermes gateway; found $($existing.Count) existing process(es)." }

New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$LogRoot = Resolve-ContainedPath $LogRoot $DataRoot 'LogRoot'
$LaunchManifest = Resolve-ContainedPath $LaunchManifest $DataRoot 'LaunchManifest'
$WrapperPath = Resolve-ContainedPath $WrapperPath $DataRoot 'GatewayWrapper'
$wrapper = @"
@echo off
set "HERMES_HOME=$HermesHome"
set "GATEWAY_MULTIPLEX_PROFILES=true"
cd /d "$WorkspaceRoot"
"$HermesExe" kanban init
if errorlevel 1 exit /b %errorlevel%
"$HermesExe" gateway run --external-supervisor -v
"@
[IO.File]::WriteAllText($WrapperPath, $wrapper, [Text.ASCIIEncoding]::new())
$process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', "`"$WrapperPath`"") -WorkingDirectory $WorkspaceRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $LogRoot 'gateway.stdout.log') -RedirectStandardError (Join-Path $LogRoot 'gateway.stderr.log') -PassThru

[ordered]@{
  schema = 'orange5.hermes-gateway-launch.v1'
  pid = $process.Id
  startTime = $process.StartTime.ToUniversalTime().ToString('o')
  executable = $HermesExe
  wrapper = $WrapperPath
  binarySha256 = $actualBinaryHash
  arguments = @('gateway', 'run', '--external-supervisor')
  hermesHome = $HermesHome
  cwd = $WorkspaceRoot
  multiplex = $true
  dispatcherOwner = 'default'
} | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $LaunchManifest -Encoding utf8

[ordered]@{
  schema = 'orange5.hermes-gateway-start-report.v1'
  status = 'STARTED_UNPROVEN'
  pid = $process.Id
  launchManifest = $LaunchManifest
  nextAction = 'Run preflight with -WriteReceipt. Do not call this ready until it passes.'
} | ConvertTo-Json -Depth 6
