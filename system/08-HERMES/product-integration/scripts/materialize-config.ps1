[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$AllowedRoot = 'C:\AtomEons',
  [string]$WorkspaceRoot = 'C:\AtomEons\ai-box\workspaces',
  [string]$OrangeModelUrl = 'http://127.0.0.1:11434/v1',
  [string]$HermesAgentModel = 'orange-navigator:ornith-1.5-9b-q4km',
  [string]$OrangeMcpUrl = 'http://127.0.0.1:7431/mcp',
  [ValidateSet('Auto', 'Compact', 'Balanced', 'Codexa')]
  [string]$SwarmProfile = 'Auto'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$TemplateRoot = Join-Path $PackRoot 'config'
$HermesHome = Join-Path $DataRoot '.hermes'
$Profiles = @('navigator', 'builder', 'researcher', 'reviewer', 'visual', 'misfit')

function Get-SwarmSizing {
  $computer = Get-CimInstance Win32_ComputerSystem
  $ramGb = [math]::Round($computer.TotalPhysicalMemory / 1GB, 1)
  $logicalCores = [int]$computer.NumberOfLogicalProcessors
  $selected = $SwarmProfile
  if ($selected -eq 'Auto') {
    if ($ramGb -ge 64 -and $logicalCores -ge 8) { $selected = 'Codexa' }
    elseif ($ramGb -ge 24 -and $logicalCores -ge 6) { $selected = 'Balanced' }
    else { $selected = 'Compact' }
  }
  $table = @{
    Compact = @{ width = 2; depth = 1; nested = $false; api = 3; durable = 3; perProfile = 1; memory = [math]::Max(6, [math]::Min(12, [math]::Floor($ramGb * 0.55))) }
    Balanced = @{ width = 4; depth = 2; nested = $true; api = 6; durable = 6; perProfile = 2; memory = [math]::Max(12, [math]::Min(28, [math]::Floor($ramGb * 0.60))) }
    Codexa = @{ width = 6; depth = 2; nested = $true; api = 8; durable = 8; perProfile = 2; memory = [math]::Min(50, [math]::Floor($ramGb * 0.55)) }
  }
  $size = $table[$selected]
  return [ordered]@{ profile = $selected.ToLowerInvariant(); detectedRamGb = $ramGb; logicalCores = $logicalCores; width = $size.width; depth = $size.depth; nested = $size.nested; api = $size.api; durable = $size.durable; perProfile = $size.perProfile; liveMemoryBudgetGb = $size.memory }
}

$SwarmSizing = Get-SwarmSizing

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

function Convert-Template([string]$Text) {
  $workspace = $WorkspaceRoot.Replace('\', '/')
  $converted = $Text.Replace('__WORKSPACE_ROOT__', $workspace).
    Replace('__ORANGE_MODEL_URL__', $OrangeModelUrl).
    Replace('__HERMES_AGENT_MODEL__', $HermesAgentModel).
    Replace('__ORANGE_MCP_URL__', $OrangeMcpUrl)
  $converted = $converted.Replace('max_concurrent_children: 6', "max_concurrent_children: $($SwarmSizing.width)").
    Replace('max_concurrent_runs: 8', "max_concurrent_runs: $($SwarmSizing.api)").
    Replace('max_in_progress: 8', "max_in_progress: $($SwarmSizing.durable)").
    Replace('max_in_progress_per_profile: 2', "max_in_progress_per_profile: $($SwarmSizing.perProfile)")
  if (-not $SwarmSizing.nested) {
    $converted = $converted.Replace('max_spawn_depth: 2', 'max_spawn_depth: 1').Replace('orchestrator_enabled: true', 'orchestrator_enabled: false')
  }
  return $converted
}

function New-Secret {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-Env([string]$Path) {
  $values = [ordered]@{}
  if (Test-Path -LiteralPath $Path) {
    foreach ($line in Get-Content -LiteralPath $Path) {
      if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
      $parts = $line.Split('=', 2)
      $values[$parts[0].Trim()] = $parts[1]
    }
  }
  return $values
}

function Write-Managed([string]$Path, [string]$Content, [bool]$Sensitive = $false) {
  $safePath = Resolve-ContainedPath $Path $DataRoot 'ManagedPath'
  $parent = Split-Path -Parent $safePath
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [void](Resolve-ContainedPath $parent $DataRoot 'ManagedParent' $true)
  [void](Resolve-ContainedPath $safePath $DataRoot 'ManagedPath')
  if (Test-Path -LiteralPath $safePath) {
    $current = Get-Content -LiteralPath $safePath -Raw
    if ($current -eq $Content) { return 'unchanged' }
    if (-not $Sensitive) {
      $backupRoot = Join-Path $DataRoot 'backups'
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
      [void](Resolve-ContainedPath $backupRoot $DataRoot 'BackupRoot')
      $relative = $safePath.Substring($DataRoot.Length).TrimStart('\').Replace('\', '-')
      Copy-Item -LiteralPath $safePath -Destination (Join-Path $backupRoot "$stamp-$relative")
    }
  }
  [IO.File]::WriteAllText($safePath, $Content, [Text.UTF8Encoding]::new($false))
  [void](Resolve-ContainedPath $safePath $DataRoot 'ManagedPath')
  return 'written'
}

function Protect-SecretFile([string]$Path) {
  [void](Resolve-ContainedPath $Path $DataRoot 'SecretFile')
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($identity.User)
  $acl.SetAccessRuleProtection($true, $false)
  $rights = [Security.AccessControl.FileSystemRights]::FullControl
  $allow = [Security.AccessControl.AccessControlType]::Allow
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
  $propagation = [Security.AccessControl.PropagationFlags]::None
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity.User, $rights, $inheritance, $propagation, $allow))
  [void]$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($systemSid, $rights, $inheritance, $propagation, $allow))
  Set-Acl -LiteralPath $Path -AclObject $acl
}

$plan = [ordered]@{
  schema = 'orange5.hermes-materialize-plan.v1'
  mode = if ($Apply) { 'apply' } else { 'dry-run' }
  dataRoot = $DataRoot
  hermesHome = $HermesHome
  workspaceRoot = $WorkspaceRoot
  orangeModelUrl = $OrangeModelUrl
  hermesAgentModel = $HermesAgentModel
  orangeMcpUrl = $OrangeMcpUrl
  swarm = $SwarmSizing
  profiles = $Profiles
  writesSecretsToRepository = $false
  gatewayOwner = 'default'
  dispatcherCount = 1
}

if (-not $Apply) {
  $plan | ConvertTo-Json -Depth 8
  exit 0
}

$DataRoot = Resolve-ContainedPath $DataRoot $AllowedRoot 'DataRoot'
$WorkspaceRoot = Resolve-ContainedPath $WorkspaceRoot $AllowedRoot 'WorkspaceRoot'
$HermesHome = Join-Path $DataRoot '.hermes'

New-Item -ItemType Directory -Force -Path $DataRoot | Out-Null
$DataRoot = Resolve-ContainedPath $DataRoot $AllowedRoot 'DataRoot'
New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null
$WorkspaceRoot = Resolve-ContainedPath $WorkspaceRoot $AllowedRoot 'WorkspaceRoot'
$HermesHome = Resolve-ContainedPath $HermesHome $DataRoot 'HermesHome'
New-Item -ItemType Directory -Force -Path $HermesHome | Out-Null
$HermesHome = Resolve-ContainedPath $HermesHome $DataRoot 'HermesHome'
$results = @()

$ownerConfig = Convert-Template (Get-Content -LiteralPath (Join-Path $TemplateRoot 'gateway-owner\config.yaml') -Raw)
$ownerSoul = Get-Content -LiteralPath (Join-Path $TemplateRoot 'gateway-owner\SOUL.md') -Raw
$results += [ordered]@{ path = Join-Path $HermesHome 'config.yaml'; status = Write-Managed (Join-Path $HermesHome 'config.yaml') $ownerConfig }
$results += [ordered]@{ path = Join-Path $HermesHome 'SOUL.md'; status = Write-Managed (Join-Path $HermesHome 'SOUL.md') $ownerSoul }

$ownerEnvPath = Join-Path $HermesHome '.env'
$ownerEnv = Read-Env $ownerEnvPath
if (-not $ownerEnv.Contains('API_SERVER_KEY')) { $ownerEnv['API_SERVER_KEY'] = New-Secret }
$ownerEnv['GATEWAY_MULTIPLEX_PROFILES'] = 'true'
$ownerEnv['API_SERVER_ENABLED'] = 'true'
$ownerEnv['API_SERVER_HOST'] = '127.0.0.1'
$ownerEnv['API_SERVER_PORT'] = '8642'
$ownerEnv['API_SERVER_MODEL_NAME'] = 'orange5-governor'
$ownerEnv['NO_PROXY'] = '127.0.0.1,localhost,::1'
$ownerText = ($ownerEnv.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
$results += [ordered]@{ path = $ownerEnvPath; status = Write-Managed $ownerEnvPath ($ownerText + "`n") $true }
Protect-SecretFile $ownerEnvPath

foreach ($profile in $Profiles) {
  $source = Join-Path $TemplateRoot "profiles\$profile"
  $target = Resolve-ContainedPath (Join-Path $HermesHome "profiles\$profile") $DataRoot 'ProfileRoot'
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  [void](Resolve-ContainedPath $target $DataRoot 'ProfileRoot')
  foreach ($name in @('config.yaml', 'SOUL.md', 'profile.json')) {
    $content = Get-Content -LiteralPath (Join-Path $source $name) -Raw
    if ($name -eq 'config.yaml') { $content = Convert-Template $content }
    $dest = Join-Path $target $name
    $results += [ordered]@{ path = $dest; status = Write-Managed $dest $content }
  }
  $envPath = Join-Path $target '.env'
  $env = Read-Env $envPath
  if (-not $env.Contains('API_SERVER_KEY')) { $env['API_SERVER_KEY'] = New-Secret }
  # Secondary multiplex profiles inherit the owner's API listener. Do not
  # write API_SERVER_ENABLED at all: Hermes treats even an explicit false
  # child platform declaration as a conflicting port-binding platform.
  $env.Remove('API_SERVER_ENABLED')
  $env['NO_PROXY'] = '127.0.0.1,localhost,::1'
  $envText = ($env.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n"
  $results += [ordered]@{ path = $envPath; status = Write-Managed $envPath ($envText + "`n") $true }
  Protect-SecretFile $envPath
}

$boardSource = Join-Path $TemplateRoot 'board\strategy.json'
$boardTarget = Join-Path $DataRoot 'board-strategy.json'
$results += [ordered]@{ path = $boardTarget; status = Write-Managed $boardTarget (Get-Content -LiteralPath $boardSource -Raw) }

[ordered]@{
  schema = 'orange5.hermes-materialize-report.v1'
  status = 'MATERIALIZED_NOT_RUNNING'
  plan = $plan
  results = $results
  nextAction = 'Run preflight, then explicitly start the single default gateway.'
} | ConvertTo-Json -Depth 10
