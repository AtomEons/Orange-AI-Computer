[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$RestartGateway,
  [string]$InstallRoot = 'C:\AtomEons\ai-box\hermes-product',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$WorkspaceRoot = 'C:\AtomEons\ai-box\workspaces',
  [string]$OrangeModelUrl = 'http://127.0.0.1:11434/v1',
  [string]$HermesAgentModel = 'orange-navigator:ornith-1.5-9b-q4km',
  [string]$OrangeMcpUrl = 'http://127.0.0.1:17431/mcp'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$Profiles = @('navigator', 'builder', 'researcher', 'reviewer', 'visual', 'misfit')
$HermesHome = Join-Path $DataRoot '.hermes'
$ReceiptRoot = Join-Path $DataRoot 'receipts'
$Stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$BackupRoot = Join-Path $DataRoot "backups\profile-deploy-$Stamp"

function Assert-Contained([string]$Path, [string]$Base, [string]$Label) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [IO.Path]::GetFullPath($Base).TrimEnd('\')
  if ($full -ne $root -and -not $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label escapes $root`: $full"
  }
  return $full
}

function Get-HashOrNull([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-ProfileTemplate([string]$Profile, [string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing $Profile template: $Path" }
  $text = Get-Content -LiteralPath $Path -Raw
  foreach ($required in @(
    '(?m)^\s*multiplex_profiles:\s*false\s*$',
    '(?m)^\s*dispatch_in_gateway:\s*false\s*$',
    '(?ms)^platforms:\s*\r?\n\s{2}api_server:\s*\r?\n\s{4}enabled:\s*false\s*$',
    '(?m)^\s*mcp_servers:\s*',
    '(?m)^\s*include:\s*\[.*orange5_health.*\]\s*$'
  )) {
    if ($text -notmatch $required) { throw "$Profile template is missing a required restriction: $required" }
  }
  if ($text -match '(?m)^\s*enabled:\s*true\s*$' -and $text -notmatch '(?ms)mcp_servers:.*enabled:\s*true') {
    throw "$Profile template contains an unexpected enabled platform: $Path"
  }
}

$InstallRoot = Assert-Contained $InstallRoot 'C:\AtomEons' 'InstallRoot'
$DataRoot = Assert-Contained $DataRoot $InstallRoot 'DataRoot'
$HermesHome = Assert-Contained $HermesHome $DataRoot 'HermesHome'
$BackupRoot = Assert-Contained $BackupRoot $DataRoot 'BackupRoot'
$ReceiptRoot = Assert-Contained $ReceiptRoot $DataRoot 'ReceiptRoot'

$source = @()
foreach ($profile in $Profiles) {
  $path = Join-Path $PackRoot "config\profiles\$profile\config.yaml"
  Assert-ProfileTemplate $profile $path
  $source += [ordered]@{ profile = $profile; path = $path; sha256 = Get-HashOrNull $path }
}

$plan = [ordered]@{
  schema = 'orange5.hermes-profile-deployment.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  installRoot = $InstallRoot
  dataRoot = $DataRoot
  modelUrl = $OrangeModelUrl
  hermesAgentModel = $HermesAgentModel
  profiles = $source
  restartsOnlyHermes = [bool]$RestartGateway
}
if (-not $Apply) { $plan | ConvertTo-Json -Depth 8; exit 0 }

New-Item -ItemType Directory -Force -Path $BackupRoot, $ReceiptRoot | Out-Null
$before = @()
foreach ($profile in $Profiles) {
  $runtime = Join-Path $HermesHome "profiles\$profile\config.yaml"
  $backup = Join-Path $BackupRoot "$profile.config.yaml"
  $beforeHash = Get-HashOrNull $runtime
  if ($beforeHash) { Copy-Item -LiteralPath $runtime -Destination $backup -Force }
  $before += [ordered]@{ profile = $profile; runtimePath = $runtime; sha256 = $beforeHash; backupPath = if ($beforeHash) { $backup } else { $null } }
}

$materializer = Join-Path $PSScriptRoot 'materialize-config.ps1'
$materializedText = & $materializer -Apply -DataRoot $DataRoot -WorkspaceRoot $WorkspaceRoot -AllowedRoot 'C:\AtomEons' -OrangeModelUrl $OrangeModelUrl -HermesAgentModel $HermesAgentModel -OrangeMcpUrl $OrangeMcpUrl -SwarmProfile Codexa | Out-String
$materialized = $materializedText | ConvertFrom-Json
if ($materialized.status -ne 'MATERIALIZED_NOT_RUNNING') { throw "Unexpected materializer status: $($materialized.status)" }

$after = @()
foreach ($profile in $Profiles) {
  $runtime = Join-Path $HermesHome "profiles\$profile\config.yaml"
  Assert-ProfileTemplate $profile $runtime
  $text = Get-Content -LiteralPath $runtime -Raw
  if ($text -notmatch [regex]::Escape($OrangeMcpUrl)) { throw "$profile runtime MCP URL is not canonical." }
  if ($text -notmatch [regex]::Escape($OrangeModelUrl)) { throw "$profile runtime model URL is not canonical." }
  if ($text -notmatch [regex]::Escape($HermesAgentModel)) { throw "$profile runtime agent model is not the requested model: $HermesAgentModel" }
  $after += [ordered]@{ profile = $profile; runtimePath = $runtime; sha256 = Get-HashOrNull $runtime }
}

$restart = [ordered]@{ requested = [bool]$RestartGateway; stoppedPids = @(); launchPid = $null; listenerPid = $null; launchMode = $null; status = 'NOT_REQUESTED' }
if ($RestartGateway) {
  $listener = @(Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue)
  if ($listener.Count -gt 1) { throw "Refusing restart: multiple listeners own port 8642." }
  $launchPath = Join-Path $DataRoot 'gateway-launch.json'
  $launch = if (Test-Path -LiteralPath $launchPath) { Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json } else { $null }
  if ($listener.Count -eq 1) {
    $pidToStop = [int]$listener[0].OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop"
    $installPrefix = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\') + '\'
    $exeInside = $process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath).StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)
    $hermesCommand = $process.CommandLine -and $process.CommandLine -match '(?i)hermes' -and $process.CommandLine -match '(?i)(gateway|api_server)'
    if (-not ($exeInside -or $hermesCommand)) { throw "Refusing restart: port 8642 owner is not verified as Hermes (pid=$pidToStop)." }
    Stop-Process -Id $pidToStop -Force
    $restart.listenerPid = $pidToStop
    $restart.stoppedPids += $pidToStop
  }
  if ($launch -and $launch.pid) {
    $launchProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$launch.pid)" -ErrorAction SilentlyContinue
    if ($launchProcess -and $launchProcess.CommandLine -match '(?i)(gateway-owner|hermes.*gateway)') {
      Stop-Process -Id ([int]$launch.pid) -Force -ErrorAction SilentlyContinue
      $restart.stoppedPids += [int]$launch.pid
    }
  }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue) { throw 'Hermes listener did not stop cleanly.' }
  $gatewayTask = Get-ScheduledTask -TaskPath '\OrangeFive\' -TaskName 'HermesGateway' -ErrorAction SilentlyContinue
  if ($gatewayTask) {
    $expectedWrapper = [IO.Path]::GetFullPath((Join-Path $DataRoot 'gateway-owner.cmd'))
    $taskActions = @($gatewayTask.Actions | ForEach-Object {
      $property = $_.PSObject.Properties['Execute']
      if ($property) { [IO.Path]::GetFullPath([string]$property.Value) } else { '' }
    })
    if ($taskActions.Count -ne 1 -or $taskActions[0] -ne $expectedWrapper) {
      throw "Hermes scheduled task action does not match the canonical wrapper: $($taskActions -join ',')"
    }
    $installManifest = Get-Content -LiteralPath (Join-Path $InstallRoot 'install-manifest.json') -Raw | ConvertFrom-Json
    $logRoot = Join-Path $DataRoot 'logs'
    New-Item -ItemType Directory -Force -Path $logRoot | Out-Null
    $stdout = Join-Path $logRoot 'gateway.stdout.log'
    $stderr = Join-Path $logRoot 'gateway.stderr.log'
    $wrapper = @"
@echo off
set "HERMES_HOME=$HermesHome"
set "GATEWAY_MULTIPLEX_PROFILES=true"
cd /d "$WorkspaceRoot"
"$($installManifest.hermesExecutable)" kanban init >> "$stdout" 2>> "$stderr"
if errorlevel 1 exit /b %errorlevel%
"$($installManifest.hermesExecutable)" gateway run --external-supervisor -v >> "$stdout" 2>> "$stderr"
"@
    [IO.File]::WriteAllText($expectedWrapper, $wrapper, [Text.ASCIIEncoding]::new())
    Start-ScheduledTask -InputObject $gatewayTask
    $restart.launchMode = 'scheduled-task'
  } else {
    $startText = & (Join-Path $PSScriptRoot 'start-owner.ps1') -Apply -InstallRoot $InstallRoot -DataRoot $DataRoot -WorkspaceRoot $WorkspaceRoot -AllowedRoot 'C:\AtomEons' | Out-String
    $started = $startText | ConvertFrom-Json
    $restart.launchPid = $started.pid
    $restart.launchMode = 'direct-hidden-process'
  }
  $deadline = (Get-Date).AddSeconds(45)
  while (-not (Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  $newListener = @(Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue)
  if ($newListener.Count -ne 1) { throw "Hermes did not return with exactly one listener; count=$($newListener.Count)." }
  $restart.listenerPid = [int]$newListener[0].OwningProcess
  if ($restart.launchMode -eq 'scheduled-task') {
    $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($restart.listenerPid)"
    $installManifest = Get-Content -LiteralPath (Join-Path $InstallRoot 'install-manifest.json') -Raw | ConvertFrom-Json
    $launchPath = Join-Path $DataRoot 'gateway-launch.json'
    $launch = [ordered]@{
      schema = 'orange5.hermes-gateway-launch.v1'
      pid = $restart.listenerPid
      startTime = ([datetime]$listenerProcess.CreationDate).ToUniversalTime().ToString('o')
      executable = [string]$installManifest.hermesExecutable
      wrapper = Join-Path $DataRoot 'gateway-owner.cmd'
      binarySha256 = [string]$installManifest.binarySha256
      arguments = @('gateway', 'run', '--external-supervisor')
      hermesHome = $HermesHome
      cwd = $WorkspaceRoot
      multiplex = $true
      dispatcherOwner = 'default'
      launchMode = 'scheduled-task'
      scheduledTask = '\OrangeFive\HermesGateway'
    }
    [IO.File]::WriteAllText($launchPath, ($launch | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    $restart.launchPid = $restart.listenerPid
  }
  $restart.status = 'RESTARTED_HERMES_ONLY'
}

$report = [ordered]@{
  schema = 'orange5.hermes-profile-deployment.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  status = 'DEPLOYED_UNPROVEN'
  source = $source
  before = $before
  after = $after
  backupRoot = $BackupRoot
  materialization = $materialized.status
  modelUrl = $OrangeModelUrl
  hermesAgentModel = $HermesAgentModel
  restart = $restart
  nextAction = 'Run strict preflight with live inference, then the constrained lease proof.'
  receiptPath = $null
}
$receiptPath = Join-Path $ReceiptRoot "hermes-profile-deployment-$Stamp.json"
$report.receiptPath = $receiptPath
[IO.File]::WriteAllText($receiptPath, ($report | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
$report | ConvertTo-Json -Depth 12
