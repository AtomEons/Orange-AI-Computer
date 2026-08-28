[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Rollback,
  [string]$SnapshotPath = '',
  [string]$OrangeRoot = '',
  [string]$CodexaHost = 'CODEXA',
  [string]$CodexaUser = 'Atom',
  [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519'),
  [string]$KnownHostsPath = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
  [string]$SshPath = '',
  [string]$ScpPath = '',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$OrangeDataRoot = 'C:\Users\Atom\OrangeBox-Data\orange5',
  [string]$BunPath = 'C:\Users\Atom\.bun\bin\bun.exe',
  [string]$TaskName = 'OrangeFive AE Staff',
  [string]$TaskPath = '\OrangeFive\',
  [ValidateRange(1, 65535)]
  [int]$Port = 8643,
  [ValidateRange(1, 65535)]
  [int]$HermesPort = 8642,
  [Parameter(DontShow)]
  [switch]$OnTarget,
  [Parameter(DontShow)]
  [string]$StagingRoot = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Schema = 'orange5.ae-staff-service-deployment.v1'
$StartedAt = (Get-Date).ToUniversalTime()
$Stamp = $StartedAt.ToString('yyyyMMddTHHmmssfffZ')
$Script:ActiveSnapshot = $null

function ConvertTo-CompactJson([object]$Value) {
  return ($Value | ConvertTo-Json -Depth 16 -Compress)
}

function Write-JsonResult([object]$Value, [int]$ExitCode = 0) {
  [Console]::Out.WriteLine((ConvertTo-CompactJson $Value))
  exit $ExitCode
}

function Get-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Test-PathContained([string]$Path, [string]$Base, [bool]$AllowBase = $false) {
  $full = Get-FullPath $Path
  $root = Get-FullPath $Base
  if ($full -eq $root) { return $AllowBase }
  return $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Assert-PathContained([string]$Path, [string]$Base, [string]$Label, [bool]$AllowBase = $false) {
  $full = Get-FullPath $Path
  if (-not (Test-PathContained $full $Base $AllowBase)) {
    throw "$Label must remain under $(Get-FullPath $Base); got $full"
  }
  return $full
}

function Assert-NoReparsePoint([string]$Path, [string]$StopAt, [string]$Label) {
  $cursor = Get-FullPath $Path
  $stop = Get-FullPath $StopAt
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -Force -LiteralPath $cursor
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label contains a reparse point: $cursor"
      }
    }
    if ($cursor -eq $stop) { break }
    $parent = [IO.Directory]::GetParent($cursor)
    if (-not $parent -or -not (Test-PathContained $parent.FullName $stop $true)) {
      throw "$Label escaped its expected root: $cursor"
    }
    $cursor = $parent.FullName.TrimEnd('\')
  }
}

function Assert-SafeTaskIdentity {
  if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{2,100}$') {
    throw "Unsafe scheduled task name: $TaskName"
  }
  if ($TaskPath -notmatch '^\\(?:[A-Za-z0-9 ._-]+\\)*$') {
    throw "Unsafe scheduled task path: $TaskPath"
  }
}

function Get-Sha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}

function New-Secret {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Get-AccessSids {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  $sids = [ordered]@{}
  $sids[$identity.User.Value] = $identity.User
  $sids[$systemSid.Value] = $systemSid
  return [ordered]@{ owner = $identity.User; all = @($sids.Values) }
}

function Protect-Directory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Force -Path $Path | Out-Null
  }
  $access = Get-AccessSids
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetOwner($access.owner)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $access.all) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-File([string]$Path) {
  $access = Get-AccessSids
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetOwner($access.owner)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $access.all) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [Security.AccessControl.FileSystemRights]::FullControl,
      [Security.AccessControl.InheritanceFlags]::None,
      [Security.AccessControl.PropagationFlags]::None,
      [Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Get-AclProof([string]$Path) {
  $allowed = @((Get-AccessSids).all | ForEach-Object { $_.Value })
  $acl = Get-Acl -LiteralPath $Path
  $rules = @($acl.Access | ForEach-Object {
    $sid = try { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$_.IdentityReference }
    [ordered]@{
      sid = $sid
      type = [string]$_.AccessControlType
      inherited = [bool]$_.IsInherited
      rights = [string]$_.FileSystemRights
    }
  })
  $unexpected = @($rules | Where-Object { $_.type -eq 'Allow' -and $_.sid -notin $allowed })
  $ownerSid = try { $acl.Owner.Translate([Security.Principal.SecurityIdentifier]).Value } catch { [string]$acl.Owner }
  return [ordered]@{
    protected = [bool]$acl.AreAccessRulesProtected
    owner = $ownerSid
    allowedSids = $allowed
    unexpectedAllowSids = @($unexpected | ForEach-Object { $_.sid })
    rules = $rules
    secure = [bool]($acl.AreAccessRulesProtected -and $unexpected.Count -eq 0)
  }
}

function Write-Utf8File([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

function Write-SecureText([string]$Path, [string]$Content) {
  $parent = Split-Path -Parent $Path
  Protect-Directory $parent
  $temporary = Join-Path $parent ('.pending-' + [guid]::NewGuid().ToString('N'))
  try {
    [IO.File]::WriteAllText($temporary, $Content, [Text.UTF8Encoding]::new($false))
    Protect-File $temporary
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Move-Item -LiteralPath $temporary -Destination $Path
    Protect-File $Path
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Read-EnvValue([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '' }
  foreach ($line in Get-Content -LiteralPath $Path) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $parts = $line.Split('=', 2)
    if ($parts[0].Trim() -eq $Name) { return $parts[1].Trim() }
  }
  return ''
}

function ConvertTo-EnvPath([string]$Path) {
  return (Get-FullPath $Path).Replace('\', '/')
}

function Get-TaskActionValue([object]$Action, [string]$Name) {
  $property = $Action.PSObject.Properties[$Name]
  if ($property) { return [string]$property.Value }
  return ''
}

function Get-ManagedTask {
  return Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue
}

function Assert-ManagedTask([object]$Task) {
  if (-not $Task) { return }
  $actions = @($Task.Actions)
  if ($actions.Count -ne 1) { throw "Task collision: $TaskPath$TaskName has $($actions.Count) actions." }
  $execute = Get-TaskActionValue $actions[0] 'Execute'
  $arguments = Get-TaskActionValue $actions[0] 'Arguments'
  $expectedService = Join-Path (Get-TargetLayout).appRoot '08-HERMES\src\staff-reactor-service.mjs'
  if ([IO.Path]::GetFileName($execute) -notmatch '^(?i)bun(?:\.exe)?$' -or $arguments -notlike "*$expectedService*") {
    throw "Task collision: $TaskPath$TaskName is not an AE Staff direct-Bun task."
  }
}

function Ensure-TaskFolder {
  if ($TaskPath -eq '\') { return }
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
  $currentPath = '\'
  $currentFolder = $service.GetFolder('\')
  foreach ($segment in $TaskPath.Trim('\').Split('\')) {
    $nextPath = if ($currentPath -eq '\') { "\$segment" } else { "$currentPath\$segment" }
    try {
      $currentFolder = $service.GetFolder($nextPath)
    } catch {
      $currentFolder = $currentFolder.CreateFolder($segment)
    }
    $currentPath = $nextPath
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'AE Staff service installation must run elevated because the task runs as SYSTEM.'
  }
}

function Get-PortListeners([int]$LocalPort) {
  return @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue)
}

function Get-ProcessForListener([object]$Listener) {
  return Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Listener.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-AeStaffProcess([object]$Process) {
  if (-not $Process -or -not $Process.CommandLine) { return $false }
  return ([IO.Path]::GetFileName([string]$Process.ExecutablePath) -match '^(?i)bun(?:\.exe)?$' -and [string]$Process.CommandLine -match '(?i)staff-reactor-service\.mjs')
}

function Test-InstalledAeStaffProcess([object]$Process) {
  if (-not (Test-AeStaffProcess $Process)) { return $false }
  $expectedService = Join-Path (Get-TargetLayout).appRoot '08-HERMES\src\staff-reactor-service.mjs'
  return [string]$Process.CommandLine -like "*$expectedService*"
}

function Stop-ManagedRuntime {
  $task = Get-ManagedTask
  if ($task) {
    Assert-ManagedTask $task
    if ([string]$task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
  }
  $deadline = (Get-Date).AddSeconds(12)
  while ((Get-PortListeners $Port).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  foreach ($listener in Get-PortListeners $Port) {
    $process = Get-ProcessForListener $listener
    if (-not (Test-InstalledAeStaffProcess $process)) {
      throw "Port $Port is not owned by this installer's managed AE Staff runtime (pid=$($listener.OwningProcess))."
    }
    Stop-Process -Id ([int]$listener.OwningProcess) -Force
  }
  $deadline = (Get-Date).AddSeconds(8)
  while ((Get-PortListeners $Port).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if ((Get-PortListeners $Port).Count -gt 0) { throw "AE Staff listener on port $Port did not stop." }
}

function New-SourceManifest([string]$Root) {
  $definitions = @(
    [ordered]@{ sourceRelativePath = '08-HERMES/src/staff-reactor-service.mjs'; stagedName = 'staff-reactor-service.mjs'; installRelativePath = '08-HERMES/src/staff-reactor-service.mjs' },
    [ordered]@{ sourceRelativePath = '08-HERMES/src/codexa-tool-catalog.mjs'; stagedName = 'codexa-tool-catalog.mjs'; installRelativePath = '08-HERMES/src/codexa-tool-catalog.mjs' },
    [ordered]@{ sourceRelativePath = '08-HERMES/src/codexa-tool-runner.mjs'; stagedName = 'codexa-tool-runner.mjs'; installRelativePath = '08-HERMES/src/codexa-tool-runner.mjs' },
    [ordered]@{ sourceRelativePath = '08-HERMES/src/staff-reactor.mjs'; stagedName = 'staff-reactor.mjs'; installRelativePath = '08-HERMES/src/staff-reactor.mjs' },
    [ordered]@{ sourceRelativePath = '08-HERMES/src/staff-continuum.mjs'; stagedName = 'staff-continuum.mjs'; installRelativePath = '08-HERMES/src/staff-continuum.mjs' },
    [ordered]@{ sourceRelativePath = '03-BACKEND/ae-phase-fabric.mjs'; stagedName = 'ae-phase-fabric.mjs'; installRelativePath = '03-BACKEND/ae-phase-fabric.mjs' },
    [ordered]@{ sourceRelativePath = '03-BACKEND/ae-phase-protocol.mjs'; stagedName = 'ae-phase-protocol.mjs'; installRelativePath = '03-BACKEND/ae-phase-protocol.mjs' },
    [ordered]@{ sourceRelativePath = '08-HERMES/product-integration/config/staff-roster.json'; stagedName = 'staff-roster.json'; installRelativePath = '08-HERMES/product-integration/config/staff-roster.json' }
  )
  return @($definitions | ForEach-Object {
    $sourcePath = Join-Path $Root ($_.sourceRelativePath.Replace('/', '\'))
    [ordered]@{
      sourceRelativePath = $_.sourceRelativePath
      sourcePath = Get-FullPath $sourcePath
      stagedName = $_.stagedName
      installRelativePath = $_.installRelativePath
      exists = Test-Path -LiteralPath $sourcePath -PathType Leaf
      sha256 = Get-Sha256 $sourcePath
    }
  })
}

function Get-LocalImportClosure([string]$Root, [string]$EntryRelativePath) {
  $rootFull = Get-FullPath $Root
  $pending = [Collections.Generic.Stack[string]]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $pending.Push($EntryRelativePath.Replace('\', '/'))
  while ($pending.Count -gt 0) {
    $relative = $pending.Pop()
    if (-not $seen.Add($relative)) { continue }
    $full = Assert-PathContained (Join-Path $rootFull $relative.Replace('/', '\')) $rootFull 'AE Staff import'
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "AE Staff import is missing: $relative" }
    $text = Get-Content -LiteralPath $full -Raw
    foreach ($match in [regex]::Matches($text, 'from\s+["''](\.[^"'']+)["'']')) {
      $resolved = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $full) $match.Groups[1].Value.Replace('/', '\')))
      [void](Assert-PathContained $resolved $rootFull 'AE Staff import')
      $next = $resolved.Substring($rootFull.Length).TrimStart('\').Replace('\', '/')
      $pending.Push($next)
    }
  }
  return @($seen | Sort-Object)
}

function Assert-SourceManifest([object[]]$Manifest) {
  $missing = @($Manifest | Where-Object { -not $_.exists -or -not $_.sha256 })
  if ($missing.Count -gt 0) {
    throw "AE Staff source bundle is incomplete: $(@($missing | ForEach-Object { $_.sourcePath }) -join ', ')"
  }
  $rosterEntry = @($Manifest | Where-Object { $_.stagedName -eq 'staff-roster.json' })[0]
  $roster = Get-Content -LiteralPath $rosterEntry.sourcePath -Raw | ConvertFrom-Json
  if (@($roster.roles).Count -ne 50) { throw 'AE Staff source roster must contain exactly 50 roles.' }
  $profiles = @($roster.roles | ForEach-Object { [string]$_.archetype } | Sort-Object -Unique)
  $expected = @('builder', 'human-operator', 'misfit', 'navigator', 'researcher', 'reviewer', 'visual')
  if (($profiles -join '|') -ne ($expected -join '|')) { throw "AE Staff roster profile set is invalid: $($profiles -join ', ')" }
  $closure = Get-LocalImportClosure $OrangeRoot '08-HERMES/src/staff-reactor-service.mjs'
  $manifestModules = @($Manifest | Where-Object { $_.stagedName -ne 'staff-roster.json' } | ForEach-Object { $_.sourceRelativePath } | Sort-Object)
  if (($closure -join '|') -ne ($manifestModules -join '|')) {
    throw "AE Staff deployment manifest does not match the current local import closure. Imports=$($closure -join ', '); manifest=$($manifestModules -join ', ')"
  }
}

function Get-SshExecutable([string]$Requested, [string]$Name) {
  if ($Requested) {
    if (-not (Test-Path -LiteralPath $Requested -PathType Leaf)) { throw "$Name not found: $Requested" }
    return (Get-FullPath $Requested)
  }
  $command = Get-Command "$Name.exe" -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name.exe is required." }
  return $command.Source
}

function Get-SshOptions {
  $options = @('-i', $SshKeyPath, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes')
  if ($KnownHostsPath) { $options += @('-o', "UserKnownHostsFile=$KnownHostsPath") }
  return $options
}

function Invoke-RemotePowerShell([string]$ScriptText) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ScriptText))
  $target = "$CodexaUser@$CodexaHost"
  $arguments = @(Get-SshOptions) + @($target, "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded")
  $output = @(& $script:SshExecutable @arguments 2>&1)
  return [ordered]@{ exitCode = [int]$LASTEXITCODE; output = @($output | ForEach-Object { [string]$_ }) }
}

function ConvertFrom-RemoteJson([object]$RemoteResult) {
  $candidates = @($RemoteResult.output | ForEach-Object { $_.Trim() } | Where-Object { $_.StartsWith('{') -and $_.EndsWith('}') })
  foreach ($candidate in @($candidates | Select-Object -Last 5)) {
    try { return ($candidate | ConvertFrom-Json) } catch { }
  }
  throw "Codexa returned no parseable JSON receipt (exit=$($RemoteResult.exitCode))."
}

function Invoke-SafeRemoteCleanup([string]$RemotePath, [string]$RemoteIncomingRoot) {
  $pathLiteral = $RemotePath.Replace("'", "''")
  $rootLiteral = $RemoteIncomingRoot.Replace("'", "''")
  $cleanup = @"
`$ErrorActionPreference = 'Stop'
`$path = [IO.Path]::GetFullPath('$pathLiteral').TrimEnd('\')
`$root = [IO.Path]::GetFullPath('$rootLiteral').TrimEnd('\')
if (`$path.StartsWith(`$root + '\', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath `$path)) {
  Remove-Item -LiteralPath `$path -Recurse -Force
}
"@
  [void](Invoke-RemotePowerShell $cleanup)
}

function Invoke-Controller {
  if (-not $OrangeRoot) {
    $script:OrangeRoot = Get-FullPath (Join-Path $PSScriptRoot '..\..\..')
  } else {
    $script:OrangeRoot = Get-FullPath $OrangeRoot
  }
  Assert-SafeTaskIdentity
  if (Test-PathContained $DataRoot $OrangeRoot $true) { throw 'DataRoot must remain outside the Orange5 repository.' }
  $sourceManifest = New-SourceManifest $OrangeRoot
  $operation = if ($Rollback) { 'rollback' } else { 'install' }
  $localReady = $true
  $localBlockers = @()
  if (-not $Rollback) {
    try { Assert-SourceManifest $sourceManifest } catch { $localReady = $false; $localBlockers += $_.Exception.Message }
  }
  foreach ($required in @($SshKeyPath, $KnownHostsPath)) {
    if ($required -and -not (Test-Path -LiteralPath $required -PathType Leaf)) {
      $localReady = $false
      $localBlockers += "Missing SSH prerequisite: $required"
    }
  }
  try {
    $script:SshExecutable = Get-SshExecutable $SshPath 'ssh'
    $script:ScpExecutable = Get-SshExecutable $ScpPath 'scp'
  } catch {
    $localReady = $false
    $localBlockers += $_.Exception.Message
  }

  if (-not $Apply) {
    Write-JsonResult ([ordered]@{
      schema = $Schema
      createdAt = $StartedAt.ToString('o')
      status = 'DRY_RUN'
      mode = $operation
      applyRequired = $true
      target = [ordered]@{ host = $CodexaHost; user = $CodexaUser; dataRoot = $DataRoot; orangeDataRoot = $OrangeDataRoot; bunPath = $BunPath }
      service = [ordered]@{ host = '127.0.0.1'; port = $Port; hermesApi = "http://127.0.0.1:$HermesPort"; roles = 50; profiles = 7 }
      task = [ordered]@{ path = $TaskPath; name = $TaskName; runAs = 'SYSTEM'; hidden = $true; executable = $BunPath; runtimePowerShell = $false }
      source = $sourceManifest
      rollbackSnapshot = if ($SnapshotPath) { $SnapshotPath } else { 'latest-protected-snapshot-on-codexa' }
      readyToApply = $localReady
      blockers = $localBlockers
      writesRepositoryFiles = $false
      receiptPath = $null
    })
  }

  if (-not $localReady) { throw ($localBlockers -join '; ') }
  if (-not $Rollback) { Assert-SourceManifest $sourceManifest }
  $script:SshExecutable = Get-SshExecutable $SshPath 'ssh'
  $script:ScpExecutable = Get-SshExecutable $ScpPath 'scp'

  $deploymentId = [guid]::NewGuid().ToString('N')
  $remoteDeploymentRoot = Join-Path $DataRoot '.hermes\ae-staff\deployment'
  $remoteIncomingRoot = Join-Path $remoteDeploymentRoot 'incoming'
  $remoteStaging = Join-Path $remoteIncomingRoot $deploymentId
  $tempBase = Get-FullPath ([IO.Path]::GetTempPath())
  $localTemp = Get-FullPath (Join-Path $tempBase "orange5-ae-staff-$deploymentId")
  if (-not (Test-PathContained $localTemp $tempBase)) { throw "Unsafe local staging path: $localTemp" }
  New-Item -ItemType Directory -Path $localTemp | Out-Null

  try {
    $manifestPath = Join-Path $localTemp 'manifest.json'
    $manifestDocument = [ordered]@{
      schema = 'orange5.ae-staff-source-manifest.v1'
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      sourceRoot = $OrangeRoot
      files = @($sourceManifest | ForEach-Object {
        [ordered]@{
          sourceRelativePath = $_.sourceRelativePath
          stagedName = $_.stagedName
          installRelativePath = $_.installRelativePath
          sha256 = $_.sha256
        }
      })
    }
    Write-Utf8File $manifestPath ((ConvertTo-CompactJson $manifestDocument) + "`n")

    $stagingLiteral = $remoteStaging.Replace("'", "''")
    $prepare = @"
`$ErrorActionPreference = 'Stop'
`$path = [IO.Path]::GetFullPath('$stagingLiteral')
New-Item -ItemType Directory -Force -Path `$path | Out-Null
[ordered]@{ ok = `$true; staging = `$path } | ConvertTo-Json -Compress
"@
    $prepared = Invoke-RemotePowerShell $prepare
    if ($prepared.exitCode -ne 0) { throw "Unable to create Codexa staging directory: $($prepared.output -join ' ')" }

    $remoteSlash = $remoteStaging.Replace('\', '/')
    $target = "$CodexaUser@$CodexaHost"
    $scpOptions = Get-SshOptions
    $copies = @([ordered]@{ local = $PSCommandPath; name = 'install-ae-staff-service.ps1' })
    if (-not $Rollback) {
      $copies += @([ordered]@{ local = $manifestPath; name = 'manifest.json' })
      $copies += @($sourceManifest | ForEach-Object { [ordered]@{ local = $_.sourcePath; name = $_.stagedName } })
    }
    foreach ($copy in $copies) {
      $destination = "${target}:$remoteSlash/$($copy.name)"
      & $script:ScpExecutable @scpOptions $copy.local $destination | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "SCP failed for $($copy.name) with exit code $LASTEXITCODE." }
    }

    $invokeArgs = @(
      "-OnTarget",
      "-Apply",
      "-StagingRoot '$($remoteStaging.Replace("'", "''"))'",
      "-OrangeRoot '$($OrangeRoot.Replace("'", "''"))'",
      "-DataRoot '$($DataRoot.Replace("'", "''"))'",
      "-OrangeDataRoot '$($OrangeDataRoot.Replace("'", "''"))'",
      "-BunPath '$($BunPath.Replace("'", "''"))'",
      "-TaskName '$($TaskName.Replace("'", "''"))'",
      "-TaskPath '$($TaskPath.Replace("'", "''"))'",
      "-Port $Port",
      "-HermesPort $HermesPort"
    )
    if ($Rollback) { $invokeArgs += '-Rollback' }
    if ($SnapshotPath) { $invokeArgs += "-SnapshotPath '$($SnapshotPath.Replace("'", "''"))'" }
    $remoteInstaller = Join-Path $remoteStaging 'install-ae-staff-service.ps1'
    $installerLiteral = $remoteInstaller.Replace("'", "''")
    $invoke = "& '$installerLiteral' $($invokeArgs -join ' ')"
    $remoteResult = Invoke-RemotePowerShell $invoke
    $remoteReceipt = ConvertFrom-RemoteJson $remoteResult
    Write-JsonResult $remoteReceipt $remoteResult.exitCode
  } finally {
    if (Get-Variable -Name remoteStaging -Scope Local -ErrorAction SilentlyContinue) {
      Invoke-SafeRemoteCleanup $remoteStaging $remoteIncomingRoot
    }
    if ((Test-PathContained $localTemp $tempBase) -and (Test-Path -LiteralPath $localTemp)) {
      Remove-Item -LiteralPath $localTemp -Recurse -Force
    }
  }
}

function Get-TargetLayout {
  $data = Get-FullPath $DataRoot
  $hermesHome = Join-Path $data '.hermes'
  $staffState = Join-Path $hermesHome 'ae-staff'
  $deployment = Join-Path $staffState 'deployment'
  return [ordered]@{
    dataRoot = $data
    hermesHome = $hermesHome
    staffState = $staffState
    deploymentRoot = $deployment
    incomingRoot = Join-Path $deployment 'incoming'
    backupRoot = Join-Path $deployment 'backups'
    receiptRoot = Join-Path $deployment 'receipts'
    appRoot = Join-Path $staffState 'runtime'
    runtimeEnv = Join-Path $deployment 'secrets\runtime.env'
  }
}

function Get-ManagedFiles([object]$Layout) {
  return @(
    [ordered]@{ installRelativePath = '08-HERMES/src/staff-reactor-service.mjs'; path = Join-Path $Layout.appRoot '08-HERMES\src\staff-reactor-service.mjs' },
    [ordered]@{ installRelativePath = '08-HERMES/src/staff-reactor.mjs'; path = Join-Path $Layout.appRoot '08-HERMES\src\staff-reactor.mjs' },
    [ordered]@{ installRelativePath = '08-HERMES/src/staff-continuum.mjs'; path = Join-Path $Layout.appRoot '08-HERMES\src\staff-continuum.mjs' },
    [ordered]@{ installRelativePath = '03-BACKEND/ae-phase-fabric.mjs'; path = Join-Path $Layout.appRoot '03-BACKEND\ae-phase-fabric.mjs' },
    [ordered]@{ installRelativePath = '03-BACKEND/ae-phase-protocol.mjs'; path = Join-Path $Layout.appRoot '03-BACKEND\ae-phase-protocol.mjs' },
    [ordered]@{ installRelativePath = '08-HERMES/product-integration/config/staff-roster.json'; path = Join-Path $Layout.appRoot '08-HERMES\product-integration\config\staff-roster.json' }
  )
}

function Write-TargetReceipt([object]$Layout, [System.Collections.IDictionary]$Receipt) {
  Protect-Directory $Layout.receiptRoot
  $path = Join-Path $Layout.receiptRoot "$Stamp-$($Receipt.status.ToString().ToLowerInvariant()).json"
  $Receipt['receiptPath'] = $path
  Write-Utf8File $path ((ConvertTo-CompactJson $Receipt) + "`n")
  return $path
}

function New-TargetSnapshot([object]$Layout, [object[]]$ManagedFiles) {
  Protect-Directory $Layout.backupRoot
  $path = Join-Path $Layout.backupRoot "$Stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  Protect-Directory $path
  $task = Get-ManagedTask
  if ($task) { Assert-ManagedTask $task }
  $taskState = if ($task) { [string]$task.State } else { $null }
  if ($task) {
    $xml = Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-SecureText (Join-Path $path 'task.xml') $xml
  }
  $hadRuntimeEnv = Test-Path -LiteralPath $Layout.runtimeEnv -PathType Leaf
  if ($hadRuntimeEnv) {
    Copy-Item -LiteralPath $Layout.runtimeEnv -Destination (Join-Path $path 'runtime.env')
    Protect-File (Join-Path $path 'runtime.env')
  }
  $fileState = @()
  for ($index = 0; $index -lt $ManagedFiles.Count; $index++) {
    $file = $ManagedFiles[$index]
    $hadFile = Test-Path -LiteralPath $file.path -PathType Leaf
    $backupName = "managed-$index.bin"
    if ($hadFile) { Copy-Item -LiteralPath $file.path -Destination (Join-Path $path $backupName) }
    $fileState += [ordered]@{
      installRelativePath = $file.installRelativePath
      path = $file.path
      hadFile = $hadFile
      backupName = if ($hadFile) { $backupName } else { $null }
      sha256 = Get-Sha256 $file.path
    }
  }
  $snapshot = [ordered]@{
    schema = 'orange5.ae-staff-service-snapshot.v1'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    task = [ordered]@{ existed = [bool]$task; state = $taskState; xml = if ($task) { 'task.xml' } else { $null } }
    runtimeEnv = [ordered]@{ existed = $hadRuntimeEnv; backup = if ($hadRuntimeEnv) { 'runtime.env' } else { $null }; sha256 = Get-Sha256 $Layout.runtimeEnv }
    files = $fileState
  }
  Write-SecureText (Join-Path $path 'snapshot.json') ((ConvertTo-CompactJson $snapshot) + "`n")
  return $path
}

function Resolve-TargetSnapshot([object]$Layout) {
  if ($SnapshotPath) {
    $candidate = Assert-PathContained $SnapshotPath $Layout.backupRoot 'SnapshotPath'
  } else {
    if (-not (Test-Path -LiteralPath $Layout.backupRoot -PathType Container)) { throw 'No AE Staff rollback snapshots exist.' }
    $latest = Get-ChildItem -LiteralPath $Layout.backupRoot -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No AE Staff rollback snapshots exist.' }
    $candidate = $latest.FullName
  }
  Assert-NoReparsePoint $candidate $Layout.backupRoot 'SnapshotPath'
  $metadata = Join-Path $candidate 'snapshot.json'
  if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { throw "Invalid rollback snapshot: $candidate" }
  return [ordered]@{ path = $candidate; document = (Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json) }
}

function Restore-TargetSnapshot([object]$Layout, [object]$ResolvedSnapshot) {
  $snapshotPath = $ResolvedSnapshot.path
  $snapshot = $ResolvedSnapshot.document
  if ($snapshot.schema -ne 'orange5.ae-staff-service-snapshot.v1') { throw 'Rollback snapshot schema is invalid.' }
  Stop-ManagedRuntime
  $currentTask = Get-ManagedTask
  if ($currentTask) {
    Assert-ManagedTask $currentTask
    Unregister-ScheduledTask -InputObject $currentTask -Confirm:$false
  }
  foreach ($file in @($snapshot.files)) {
    $managedPath = Assert-PathContained ([string]$file.path) $Layout.appRoot 'Snapshot managed file'
    if ([bool]$file.hadFile) {
      $backup = Assert-PathContained (Join-Path $snapshotPath ([string]$file.backupName)) $snapshotPath 'Snapshot file backup'
      $parent = Split-Path -Parent $managedPath
      if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
      Copy-Item -LiteralPath $backup -Destination $managedPath -Force
    } elseif (Test-Path -LiteralPath $managedPath) {
      Remove-Item -LiteralPath $managedPath -Force
    }
  }
  if ([bool]$snapshot.runtimeEnv.existed) {
    $runtimeBackup = Assert-PathContained (Join-Path $snapshotPath ([string]$snapshot.runtimeEnv.backup)) $snapshotPath 'Snapshot runtime backup'
    Copy-Item -LiteralPath $runtimeBackup -Destination $Layout.runtimeEnv -Force
    Protect-File $Layout.runtimeEnv
  } elseif (Test-Path -LiteralPath $Layout.runtimeEnv) {
    Remove-Item -LiteralPath $Layout.runtimeEnv -Force
  }
  if ([bool]$snapshot.task.existed) {
    Ensure-TaskFolder
    $xmlPath = Assert-PathContained (Join-Path $snapshotPath ([string]$snapshot.task.xml)) $snapshotPath 'Snapshot task backup'
    $xml = Get-Content -LiteralPath $xmlPath -Raw
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml $xml -Force | Out-Null
    if ([string]$snapshot.task.state -eq 'Running') { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
  }
  return [ordered]@{
    snapshotPath = $snapshotPath
    restoredTask = [bool]$snapshot.task.existed
    restoredTaskState = [string]$snapshot.task.state
    restoredRuntimeEnv = [bool]$snapshot.runtimeEnv.existed
    restoredFiles = @($snapshot.files | Where-Object { $_.hadFile } | ForEach-Object { $_.path })
  }
}

function Get-StagedManifest([object]$Layout) {
  if (-not $StagingRoot) { throw 'Target installation requires StagingRoot.' }
  $staging = Assert-PathContained $StagingRoot $Layout.incomingRoot 'StagingRoot'
  Assert-NoReparsePoint $staging $Layout.incomingRoot 'StagingRoot'
  $manifestPath = Join-Path $staging 'manifest.json'
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Missing staged manifest: $manifestPath" }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema -ne 'orange5.ae-staff-source-manifest.v1') { throw 'Staged source manifest schema is invalid.' }
  $expectedNames = @('staff-reactor-service.mjs', 'staff-reactor.mjs', 'staff-continuum.mjs', 'codexa-tool-catalog.mjs', 'codexa-tool-runner.mjs', 'ae-phase-fabric.mjs', 'ae-phase-protocol.mjs', 'staff-roster.json')
  $actualNames = @($manifest.files | ForEach-Object { [string]$_.stagedName } | Sort-Object)
  if (($actualNames -join '|') -ne (($expectedNames | Sort-Object) -join '|')) { throw 'Staged source manifest contains an unexpected file set.' }
  foreach ($file in @($manifest.files)) {
    $path = Assert-PathContained (Join-Path $staging ([string]$file.stagedName)) $staging 'Staged file'
    if ((Get-Sha256 $path) -ne [string]$file.sha256) { throw "Staged source hash mismatch: $($file.stagedName)" }
  }
  $rosterFile = @($manifest.files | Where-Object { $_.stagedName -eq 'staff-roster.json' })[0]
  $rosterPath = Join-Path $staging ([string]$rosterFile.stagedName)
  $roster = Get-Content -LiteralPath $rosterPath -Raw | ConvertFrom-Json
  if (@($roster.roles).Count -ne 50) { throw 'Staged roster must contain exactly 50 roles.' }
  $profiles = @($roster.roles | ForEach-Object { [string]$_.archetype } | Sort-Object -Unique)
  if ($profiles.Count -ne 7) { throw 'Staged roster must map to exactly seven Hermes profiles.' }
  return [ordered]@{ root = $staging; document = $manifest; roster = $roster }
}

function Copy-StagedRuntime([object]$Layout, [object]$Staged) {
  foreach ($file in @($Staged.document.files)) {
    $source = Assert-PathContained (Join-Path $Staged.root ([string]$file.stagedName)) $Staged.root 'Staged file'
    $destination = Assert-PathContained (Join-Path $Layout.appRoot ([string]$file.installRelativePath).Replace('/', '\')) $Layout.appRoot 'Runtime destination'
    $parent = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $source -Destination $destination -Force
    if ((Get-Sha256 $destination) -ne [string]$file.sha256) { throw "Installed source hash mismatch: $destination" }
  }
}

function Test-InstalledRuntimeBundle([object]$Layout) {
  $servicePath = Join-Path $Layout.appRoot '08-HERMES\src\staff-reactor-service.mjs'
  $temporary = Join-Path $Layout.deploymentRoot ('.bundle-check-' + [guid]::NewGuid().ToString('N') + '.mjs')
  try {
    $output = (& $BunPath build $servicePath '--target=bun' "--outfile=$temporary" 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporary -PathType Leaf)) {
      throw "Bun could not resolve and bundle the staged AE Staff runtime: $output"
    }
    return [ordered]@{ ok = $true; entry = $servicePath; bundledBytes = [long](Get-Item -LiteralPath $temporary).Length }
  } finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
  }
}

function Get-TargetPrerequisiteProof([object]$Layout) {
  $profiles = @('navigator', 'builder', 'researcher', 'reviewer', 'visual', 'misfit', 'human-operator')
  $profileProof = @($profiles | ForEach-Object {
    $path = Join-Path $Layout.hermesHome "profiles\$_\.env"
    $keyPresent = [bool](Read-EnvValue $path 'API_SERVER_KEY')
    [ordered]@{ profile = $_; envPath = $path; envExists = Test-Path -LiteralPath $path -PathType Leaf; keyPresent = $keyPresent }
  })
  $invalidProfiles = @($profileProof | Where-Object { -not $_.envExists -or -not $_.keyPresent })
  if ($invalidProfiles.Count -gt 0) { throw "Hermes execution profile keys are unavailable: $(@($invalidProfiles | ForEach-Object { $_.profile }) -join ', ')" }

  $hermesListeners = @(Get-NetTCPConnection -State Listen -LocalPort $HermesPort -ErrorAction SilentlyContinue)
  if ($hermesListeners.Count -ne 1 -or [string]$hermesListeners[0].LocalAddress -ne '127.0.0.1') {
    throw "Hermes must own exactly one 127.0.0.1:$HermesPort listener before AE Staff installation."
  }

  $phaseKey = Join-Path $OrangeDataRoot 'secrets\ae-phase-key.txt'
  if (-not (Test-Path -LiteralPath $phaseKey -PathType Leaf)) { throw "AE Phase key is missing: $phaseKey" }
  $phase = Invoke-RestMethod -Uri 'http://127.0.0.1:8907/health' -Method Get -TimeoutSec 5
  if (-not $phase.ok -or $phase.status -ne 'AE_PHASE_FABRIC_ACTIVE' -or -not $phase.authenticated -or [int]$phase.connectedPeers -lt 1) {
    throw 'AE Phase is not active, authenticated, and connected on Codexa.'
  }
  return [ordered]@{
    hermes = [ordered]@{ endpoint = "http://127.0.0.1:$HermesPort"; listenerPid = [int]$hermesListeners[0].OwningProcess; profiles = $profileProof }
    aePhase = [ordered]@{ status = [string]$phase.status; authenticated = [bool]$phase.authenticated; encrypted = [string]$phase.encrypted; nodeId = [string]$phase.nodeId; connectedPeers = [int]$phase.connectedPeers; stateConverged = [bool](@($phase.peers | Where-Object { $_.stateConverged }).Count -ge 1) }
  }
}

function Write-RuntimeEnvironment([object]$Layout) {
  $key = Read-EnvValue $Layout.runtimeEnv 'AE_STAFF_API_KEY'
  if ($key -and $key -notmatch '^[A-Za-z0-9_-]{40,128}$') { throw 'Existing AE Staff client key is malformed; refusing implicit rotation.' }
  $generated = $false
  if (-not $key) { $key = New-Secret; $generated = $true }
  $rosterPath = Join-Path $Layout.appRoot '08-HERMES\product-integration\config\staff-roster.json'
  $values = [ordered]@{
    AE_STAFF_API_KEY = $key
    AE_STAFF_HOST = '127.0.0.1'
    AE_STAFF_PORT = [string]$Port
    AE_STAFF_ALLOW_HTTP_RECOVERY = '1'
    AE_STAFF_ROSTER = ConvertTo-EnvPath $rosterPath
    AE_STAFF_STATE = ConvertTo-EnvPath $Layout.staffState
    AE_STAFF_EVENT_LOG = ConvertTo-EnvPath (Join-Path $Layout.staffState 'events.jsonl')
    AE_STAFF_RECEIPT_DIR = ConvertTo-EnvPath (Join-Path $Layout.staffState 'receipts')
    HERMES_HOME = ConvertTo-EnvPath $Layout.hermesHome
    HERMES_API_URL = "http://127.0.0.1:$HermesPort"
    AE_PHASE_MODEL_URL = 'http://127.0.0.1:11434'
    AE_PHASE_NAVIGATOR_URL = 'http://127.0.0.1:11436'
    AE_PHASE_NAVIGATOR_MODEL = 'orange-navigator:7b-vulkan'
    ORANGE5_NAVIGATOR_MODEL = 'orange-navigator:ornith-1.5-9b-q4km'
    ORANGE5_DATA_ROOT = ConvertTo-EnvPath $OrangeDataRoot
    ORANGE5_AE_PHASE_KEY_FILE = ConvertTo-EnvPath (Join-Path $OrangeDataRoot 'secrets\ae-phase-key.txt')
    NO_PROXY = '127.0.0.1,localhost,::1'
  }
  $text = (@($values.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join "`n") + "`n"
  Write-SecureText $Layout.runtimeEnv $text
  $acl = Get-AclProof $Layout.runtimeEnv
  if (-not $acl.secure) { throw 'AE Staff runtime key ACL verification failed.' }
  return [ordered]@{ key = $key; generated = $generated; sha256 = Get-TextSha256 $key; acl = $acl }
}

function Register-AeStaffTask([object]$Layout) {
  Ensure-TaskFolder
  $servicePath = Join-Path $Layout.appRoot '08-HERMES\src\staff-reactor-service.mjs'
  $arguments = "--no-env-file --env-file=`"$($Layout.runtimeEnv)`" `"$servicePath`""
  $action = New-ScheduledTaskAction -Execute $BunPath -Argument $arguments -WorkingDirectory $Layout.appRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -Hidden `
    -MultipleInstances IgnoreNew `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $definition -Force | Out-Null
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
}

function Wait-AeStaffHealth([object]$Layout, [string]$Key) {
  $deadline = (Get-Date).AddSeconds(35)
  $lastError = $null
  do {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -Method Get -TimeoutSec 3
      $authProperty = $health.PSObject.Properties['authenticatedRecoveryHttp']
      if (-not $authProperty) { $authProperty = $health.PSObject.Properties['authenticated'] }
      $authenticated = [bool]($authProperty -and $authProperty.Value)
      if ($health.ok -and $health.status -eq 'LIVE' -and [int]$health.roleCount -eq 50 -and $authenticated) {
        $staff = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/staff" -Method Get -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 4
        if ($staff.status -eq 'LIVE' -and [int]$staff.roleCount -eq 50) {
          return [ordered]@{ health = $health; staff = [ordered]@{ status = $staff.status; roleCount = [int]$staff.roleCount; readyCount = [int]$staff.readyCount } }
        }
      }
    } catch {
      $lastError = $_.Exception.Message
    }
  } while ((Get-Date) -lt $deadline)
  throw "AE Staff failed authenticated loopback health proof: $lastError"
}

function Get-TaskProof([object]$Layout) {
  $task = Get-ManagedTask
  if (-not $task) { throw 'AE Staff scheduled task disappeared after registration.' }
  Assert-ManagedTask $task
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
  $actions = @($task.Actions)
  $listeners = Get-PortListeners $Port
  if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -ne '127.0.0.1') {
    throw "AE Staff must own exactly one 127.0.0.1:$Port listener; observed $($listeners.Count)."
  }
  $process = Get-ProcessForListener $listeners[0]
  if (-not (Test-AeStaffProcess $process)) { throw 'AE Staff listener is not owned by the expected direct-Bun process.' }
  $expectedService = Join-Path $Layout.appRoot '08-HERMES\src\staff-reactor-service.mjs'
  if ([string]$process.CommandLine -notlike "*$expectedService*") { throw 'AE Staff listener command line does not contain the managed service path.' }
  if ([string]$task.State -ne 'Running') { throw "AE Staff task is not running: $($task.State)" }
  if (-not [bool]$task.Settings.Hidden) { throw 'AE Staff task is not hidden.' }
  $execute = Get-TaskActionValue $actions[0] 'Execute'
  if ((Get-FullPath $execute) -ne (Get-FullPath $BunPath)) { throw "AE Staff task executable drifted: $execute" }
  return [ordered]@{
    taskPath = $TaskPath
    taskName = $TaskName
    state = [string]$task.State
    lastTaskResult = [long]$info.LastTaskResult
    execute = $execute
    arguments = Get-TaskActionValue $actions[0] 'Arguments'
    workingDirectory = Get-TaskActionValue $actions[0] 'WorkingDirectory'
    runAs = [string]$task.Principal.UserId
    hidden = [bool]$task.Settings.Hidden
    runtimePowerShell = $false
    listener = [ordered]@{ address = [string]$listeners[0].LocalAddress; port = [int]$listeners[0].LocalPort; pid = [int]$listeners[0].OwningProcess; executable = [string]$process.ExecutablePath }
  }
}

function Invoke-Target {
  Assert-SafeTaskIdentity
  Assert-Administrator
  $layout = Get-TargetLayout
  if (Test-PathContained $layout.dataRoot $OrangeRoot $true) { throw 'Target DataRoot must remain outside the Orange5 repository.' }
  if (-not (Test-Path -LiteralPath $layout.dataRoot -PathType Container)) { throw "Hermes data root does not exist: $($layout.dataRoot)" }
  Assert-NoReparsePoint $layout.dataRoot $layout.dataRoot 'DataRoot'
  if (-not $Apply) {
    Write-JsonResult ([ordered]@{ schema = $Schema; createdAt = $StartedAt.ToString('o'); status = 'DRY_RUN'; mode = if ($Rollback) { 'rollback' } else { 'install' }; applyRequired = $true })
  }

  if ($Rollback) {
    $resolved = Resolve-TargetSnapshot $layout
    $restored = Restore-TargetSnapshot $layout $resolved
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = 'ROLLED_BACK'
      mode = 'rollback'
      host = $env:COMPUTERNAME
      restored = $restored
      serviceVerification = 'prior state restored; no green runtime claim made'
      receiptPath = $null
    }
    [void](Write-TargetReceipt $layout $receipt)
    Write-JsonResult $receipt
  }

  if (-not (Test-Path -LiteralPath $OrangeDataRoot -PathType Container)) { throw "Orange data root does not exist on Codexa: $OrangeDataRoot" }
  if (-not (Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw "Bun executable is missing on Codexa: $BunPath" }
  $bunVersion = (& $BunPath --version 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $bunVersion) { throw "Bun validation failed: $BunPath" }
  $prerequisiteProof = Get-TargetPrerequisiteProof $layout
  $prerequisiteProof['bun'] = [ordered]@{ path = $BunPath; version = $bunVersion; sha256 = Get-Sha256 $BunPath }
  $staged = Get-StagedManifest $layout
  $managedFiles = Get-ManagedFiles $layout
  $existingTask = Get-ManagedTask
  if ($existingTask) { Assert-ManagedTask $existingTask }
  $listeners = Get-PortListeners $Port
  if ($listeners.Count -gt 0 -and -not $existingTask) {
    throw "Port $Port has an unmanaged listener; refusing to interrupt another deployment."
  }
  foreach ($listener in $listeners) {
    if (-not (Test-InstalledAeStaffProcess (Get-ProcessForListener $listener))) {
      throw "Port $Port is not owned by this installer's managed runtime (pid=$($listener.OwningProcess))."
    }
  }
  $Script:ActiveSnapshot = New-TargetSnapshot $layout $managedFiles

  try {
    Stop-ManagedRuntime
    $existingTask = Get-ManagedTask
    if ($existingTask) { Unregister-ScheduledTask -InputObject $existingTask -Confirm:$false }
    Copy-StagedRuntime $layout $staged
    $bundleProof = Test-InstalledRuntimeBundle $layout
    $keyState = Write-RuntimeEnvironment $layout
    Register-AeStaffTask $layout
    $healthProof = Wait-AeStaffHealth $layout $keyState.key
    $taskProof = Get-TaskProof $layout
    $installed = @($staged.document.files | ForEach-Object {
      $destination = Join-Path $layout.appRoot ([string]$_.installRelativePath).Replace('/', '\')
      [ordered]@{ source = $_.sourceRelativePath; path = $destination; sha256 = Get-Sha256 $destination; expectedSha256 = [string]$_.sha256 }
    })
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = 'INSTALLED_VERIFIED'
      mode = 'install'
      host = $env:COMPUTERNAME
      sourceManifest = $staged.document
      installed = $installed
      bundleProof = $bundleProof
      prerequisites = $prerequisiteProof
      appRoot = $layout.appRoot
      dataRoot = $layout.dataRoot
      clientKey = [ordered]@{ path = $layout.runtimeEnv; generated = $keyState.generated; sha256 = $keyState.sha256; acl = $keyState.acl; valueEmitted = $false }
      service = [ordered]@{ endpoint = "http://127.0.0.1:$Port"; roles = [int]$healthProof.health.roleCount; profiles = 7; authenticatedRecoveryHttp = $true; transportPrimary = [string]$healthProof.health.transport.primary; staff = $healthProof.staff; hermesApi = [string]$healthProof.health.hermesApi; dispatchProven = $false }
      task = $taskProof
      rollbackSnapshot = $Script:ActiveSnapshot
      rollbackCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File .\install-ae-staff-service.ps1 -Rollback -Apply -SnapshotPath '$($Script:ActiveSnapshot)'"
      writesRepositoryFiles = $false
      receiptPath = $null
    }
    [void](Write-TargetReceipt $layout $receipt)
    Write-JsonResult $receipt
  } catch {
    $failureMessage = $_.Exception.Message
    $rollbackResult = $null
    $rollbackError = $null
    if ($Script:ActiveSnapshot) {
      try {
        $resolved = [ordered]@{ path = $Script:ActiveSnapshot; document = (Get-Content -LiteralPath (Join-Path $Script:ActiveSnapshot 'snapshot.json') -Raw | ConvertFrom-Json) }
        $rollbackResult = Restore-TargetSnapshot $layout $resolved
      } catch {
        $rollbackError = $_.Exception.Message
      }
    }
    $status = if ($rollbackError) { 'FAILED_ROLLBACK_ATTENTION' } else { 'FAILED_ROLLED_BACK' }
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = $status
      mode = 'install'
      host = $env:COMPUTERNAME
      error = $failureMessage
      rollbackSnapshot = $Script:ActiveSnapshot
      rollback = $rollbackResult
      rollbackError = $rollbackError
      receiptPath = $null
    }
    try { [void](Write-TargetReceipt $layout $receipt) } catch { }
    Write-JsonResult $receipt 1
  }
}

try {
  if ($OnTarget) { Invoke-Target }
  Invoke-Controller
} catch {
  Write-JsonResult ([ordered]@{
    schema = $Schema
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    status = 'BLOCKED'
    mode = if ($Rollback) { 'rollback' } else { 'install' }
    error = $_.Exception.Message
    receiptPath = $null
  }) 1
}
