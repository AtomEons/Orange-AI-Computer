[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Rollback,
  [string]$SnapshotPath = '',
  [string]$CodexaHost = 'CODEXA',
  [string]$CodexaUser = 'Atom',
  [string]$SshKeyPath = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519'),
  [string]$KnownHostsPath = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
  [string]$SshPath = '',
  [string]$LocalDataRoot = (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5'),
  [string]$ClientKeyPath = '',
  [string]$RemoteKeyPath = 'C:\AtomEons\ai-box\hermes-product\data\.hermes\ae-staff\deployment\secrets\runtime.env',
  [string]$TaskName = 'OrangeFive AE Staff Tunnel',
  [string]$TaskPath = '\OrangeFive\',
  [ValidateRange(1, 65535)]
  [int]$LocalPort = 18643,
  [ValidateRange(1, 65535)]
  [int]$RemotePort = 8643
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Schema = 'orange5.ae-staff-client-provision.v1'
$StartedAt = (Get-Date).ToUniversalTime()
$Stamp = $StartedAt.ToString('yyyyMMddTHHmmssfffZ')
$Script:ActiveSnapshot = $null

function ConvertTo-CompactJson([object]$Value) {
  return ($Value | ConvertTo-Json -Depth 14 -Compress)
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

function Assert-OutsideGitRepository([string]$Path) {
  $cursor = Split-Path -Parent (Get-FullPath $Path)
  while ($cursor) {
    if (Test-Path -LiteralPath (Join-Path $cursor '.git')) {
      throw "Client key must remain outside a Git repository: $Path"
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if (-not $parent -or $parent.FullName -eq $cursor) { break }
    $cursor = $parent.FullName
  }
}

function Assert-SafeTaskIdentity {
  if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._-]{2,100}$') { throw "Unsafe scheduled task name: $TaskName" }
  if ($TaskPath -notmatch '^\\(?:[A-Za-z0-9 ._-]+\\)*$') { throw "Unsafe scheduled task path: $TaskPath" }
}

function Get-TextSha256([string]$Text) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha.Dispose()
  }
}

function Get-FileSha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Force -Path $Path | Out-Null }
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
    [ordered]@{ sid = $sid; type = [string]$_.AccessControlType; inherited = [bool]$_.IsInherited; rights = [string]$_.FileSystemRights }
  })
  $unexpected = @($rules | Where-Object { $_.type -eq 'Allow' -and $_.sid -notin $allowed })
  return [ordered]@{
    protected = [bool]$acl.AreAccessRulesProtected
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

function Write-SecureClientKey([string]$Path, [string]$Key, [string]$StagingBase) {
  $destinationParent = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $destinationParent)) { New-Item -ItemType Directory -Force -Path $destinationParent | Out-Null }
  Protect-Directory $StagingBase
  $stage = Join-Path $StagingBase ([guid]::NewGuid().ToString('N'))
  Protect-Directory $stage
  $temporary = Join-Path $stage 'ae-staff-client-key.txt'
  try {
    [IO.File]::WriteAllText($temporary, ($Key + "`n"), [Text.UTF8Encoding]::new($false))
    Protect-File $temporary
    if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }
    Move-Item -LiteralPath $temporary -Destination $Path
    Protect-File $Path
  } finally {
    if ((Test-PathContained $stage $StagingBase) -and (Test-Path -LiteralPath $stage)) {
      Remove-Item -LiteralPath $stage -Recurse -Force
    }
  }
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
  $forward = "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort"
  $target = "$CodexaUser@$CodexaHost"
  if ([IO.Path]::GetFileName($execute) -notmatch '^(?i)ssh(?:\.exe)?$' -or $arguments -notlike "*$forward*" -or $arguments -notlike "*$target*" -or $arguments -notlike "*$SshKeyPath*") {
    throw "Task collision: $TaskPath$TaskName is not the managed AE Staff SSH tunnel."
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
    try { $currentFolder = $service.GetFolder($nextPath) } catch { $currentFolder = $currentFolder.CreateFolder($segment) }
    $currentPath = $nextPath
  }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'AE Staff client provisioning must run elevated to create a startup S4U task.'
  }
}

function Get-SshExecutable {
  if ($SshPath) {
    if (-not (Test-Path -LiteralPath $SshPath -PathType Leaf)) { throw "ssh.exe not found: $SshPath" }
    return (Get-FullPath $SshPath)
  }
  $command = Get-Command ssh.exe -ErrorAction SilentlyContinue
  if (-not $command) { throw 'ssh.exe is required.' }
  return $command.Source
}

function Get-SshOptions([bool]$ForTunnel = $false) {
  $options = @(
    '-T',
    '-i', $SshKeyPath,
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', "UserKnownHostsFile=$KnownHostsPath"
  )
  if ($ForTunnel) {
    $options = @('-N') + $options + @(
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-L', "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort"
    )
  }
  return $options
}

function Invoke-RemotePowerShell([string]$ScriptText) {
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ScriptText))
  $target = "$CodexaUser@$CodexaHost"
  $arguments = @(Get-SshOptions $false) + @($target, "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded")
  $output = @(& $script:SshExecutable @arguments 2>&1)
  return [ordered]@{ exitCode = [int]$LASTEXITCODE; output = @($output | ForEach-Object { [string]$_ }) }
}

function Get-RemoteStaffProof {
  $remoteKeyLiteral = $RemoteKeyPath.Replace("'", "''")
  $scriptText = @"
`$ErrorActionPreference = 'Stop'
`$ProgressPreference = 'SilentlyContinue'
`$health = Invoke-RestMethod -Uri 'http://127.0.0.1:$RemotePort/health' -Method Get -TimeoutSec 5
`$authProperty = `$health.PSObject.Properties['authenticatedRecoveryHttp']
if (-not `$authProperty) { `$authProperty = `$health.PSObject.Properties['authenticated'] }
`$authenticated = [bool](`$authProperty -and `$authProperty.Value)
if (-not `$health.ok -or `$health.status -ne 'LIVE' -or [int]`$health.roleCount -ne 50 -or -not `$authenticated) {
  throw 'Codexa AE Staff health contract is not ready.'
}
`$line = Get-Content -LiteralPath '$remoteKeyLiteral' | Where-Object { `$_ -match '^AE_STAFF_API_KEY=' } | Select-Object -First 1
if (-not `$line) { throw 'Codexa AE Staff runtime key is unavailable.' }
`$key = `$line.Split('=', 2)[1].Trim()
if (`$key -notmatch '^[A-Za-z0-9_-]{40,128}$') { throw 'Codexa AE Staff runtime key is malformed.' }
[ordered]@{ health = [ordered]@{ ok = [bool]`$health.ok; status = [string]`$health.status; roleCount = [int]`$health.roleCount; authenticatedRecoveryHttp = `$authenticated; transportPrimary = [string]`$health.transport.primary }; key = `$key } | ConvertTo-Json -Compress
"@
  $remote = Invoke-RemotePowerShell $scriptText
  if ($remote.exitCode -ne 0) { throw "Codexa AE Staff proof failed: $($remote.output -join ' ')" }
  $candidates = @($remote.output | ForEach-Object { $_.Trim() } | Where-Object { $_.StartsWith('{') -and $_.EndsWith('}') })
  foreach ($candidate in @($candidates | Select-Object -Last 5)) {
    try {
      $parsed = $candidate | ConvertFrom-Json
      if ($parsed.key -match '^[A-Za-z0-9_-]{40,128}$') { return $parsed }
    } catch { }
  }
  throw 'Codexa AE Staff proof returned no valid JSON payload.'
}

function Get-PortListeners {
  return @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue)
}

function Get-ListenerProcess([object]$Listener) {
  return Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$Listener.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-ManagedTunnelProcess([object]$Process) {
  if (-not $Process -or -not $Process.CommandLine) { return $false }
  $forward = "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort"
  return ([IO.Path]::GetFileName([string]$Process.ExecutablePath) -match '^(?i)ssh(?:\.exe)?$' -and [string]$Process.CommandLine -like "*$forward*")
}

function Stop-ManagedTunnel {
  $task = Get-ManagedTask
  if ($task) {
    Assert-ManagedTask $task
    if ([string]$task.State -eq 'Running') { Stop-ScheduledTask -InputObject $task }
  }
  if (-not $task -and (Get-PortListeners).Count -gt 0) {
    throw "Local port $LocalPort has an unmanaged listener; refusing to interrupt another deployment."
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-PortListeners).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  foreach ($listener in Get-PortListeners) {
    $process = Get-ListenerProcess $listener
    if (-not (Test-ManagedTunnelProcess $process)) {
      throw "Local port $LocalPort is owned by an unrelated process (pid=$($listener.OwningProcess))."
    }
    Stop-Process -Id ([int]$listener.OwningProcess) -Force
  }
  $deadline = (Get-Date).AddSeconds(5)
  while ((Get-PortListeners).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if ((Get-PortListeners).Count -gt 0) { throw "AE Staff tunnel on local port $LocalPort did not stop." }
}

function Quote-TaskArgument([string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { throw 'Unsafe character in scheduled task argument.' }
  return '"' + $Value + '"'
}

function Get-TunnelArgumentString {
  $target = "$CodexaUser@$CodexaHost"
  $parts = @(
    '-N',
    '-T',
    '-i', (Quote-TaskArgument $SshKeyPath),
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', (Quote-TaskArgument "UserKnownHostsFile=$KnownHostsPath"),
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort",
    $target
  )
  return ($parts -join ' ')
}

function Register-TunnelTask {
  Ensure-TaskFolder
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $action = New-ScheduledTaskAction -Execute $script:SshExecutable -Argument (Get-TunnelArgumentString) -WorkingDirectory (Split-Path -Parent $SshKeyPath)
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
  $principal = New-ScheduledTaskPrincipal -UserId $identity.Name -LogonType S4U -RunLevel Limited
  $definition = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal
  Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -InputObject $definition -Force | Out-Null
  Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
}

function Wait-ClientHealth([string]$Key) {
  $deadline = (Get-Date).AddSeconds(30)
  $lastError = $null
  do {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/health" -Method Get -TimeoutSec 3
      $authProperty = $health.PSObject.Properties['authenticatedRecoveryHttp']
      if (-not $authProperty) { $authProperty = $health.PSObject.Properties['authenticated'] }
      $authenticated = [bool]($authProperty -and $authProperty.Value)
      if ($health.ok -and $health.status -eq 'LIVE' -and [int]$health.roleCount -eq 50 -and $authenticated) {
        $staff = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/staff" -Method Get -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 4
        if ($staff.status -eq 'LIVE' -and [int]$staff.roleCount -eq 50) {
          return [ordered]@{ health = $health; staff = [ordered]@{ status = [string]$staff.status; roleCount = [int]$staff.roleCount; readyCount = [int]$staff.readyCount } }
        }
      }
    } catch { $lastError = $_.Exception.Message }
  } while ((Get-Date) -lt $deadline)
  throw "AE Staff client tunnel failed authenticated health proof: $lastError"
}

function Get-TaskProof {
  $task = Get-ManagedTask
  if (-not $task) { throw 'AE Staff tunnel task disappeared after registration.' }
  Assert-ManagedTask $task
  if ([string]$task.State -ne 'Running') { throw "AE Staff tunnel task is not running: $($task.State)" }
  if (-not [bool]$task.Settings.Hidden) { throw 'AE Staff tunnel task is not hidden.' }
  $listeners = Get-PortListeners
  if ($listeners.Count -ne 1 -or [string]$listeners[0].LocalAddress -ne '127.0.0.1') {
    throw "AE Staff client must own exactly one 127.0.0.1:$LocalPort listener; observed $($listeners.Count)."
  }
  $process = Get-ListenerProcess $listeners[0]
  if (-not (Test-ManagedTunnelProcess $process)) { throw 'AE Staff client listener is not owned by the expected SSH tunnel.' }
  $action = @($task.Actions)[0]
  $execute = Get-TaskActionValue $action 'Execute'
  if ((Get-FullPath $execute) -ne (Get-FullPath $script:SshExecutable)) { throw "AE Staff tunnel executable drifted: $execute" }
  $info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
  return [ordered]@{
    taskPath = $TaskPath
    taskName = $TaskName
    state = [string]$task.State
    lastTaskResult = [long]$info.LastTaskResult
    execute = $execute
    arguments = Get-TaskActionValue $action 'Arguments'
    runAs = [string]$task.Principal.UserId
    logonType = [string]$task.Principal.LogonType
    hidden = [bool]$task.Settings.Hidden
    runtimePowerShell = $false
    listener = [ordered]@{ address = [string]$listeners[0].LocalAddress; port = [int]$listeners[0].LocalPort; pid = [int]$listeners[0].OwningProcess; executable = [string]$process.ExecutablePath }
  }
}

function Get-Layout {
  $root = Get-FullPath $LocalDataRoot
  $deployment = Join-Path $root 'deployments\ae-staff-client'
  return [ordered]@{
    root = $root
    deployment = $deployment
    backupRoot = Join-Path $deployment 'backups'
    receiptRoot = Join-Path $deployment 'receipts'
    stagingRoot = Join-Path $deployment 'staging'
    clientKey = Get-FullPath $ClientKeyPath
  }
}

function Write-Receipt([object]$Layout, [System.Collections.IDictionary]$Receipt) {
  Protect-Directory $Layout.receiptRoot
  $path = Join-Path $Layout.receiptRoot "$Stamp-$($Receipt.status.ToString().ToLowerInvariant()).json"
  $Receipt['receiptPath'] = $path
  Write-Utf8File $path ((ConvertTo-CompactJson $Receipt) + "`n")
  return $path
}

function New-Snapshot([object]$Layout) {
  Protect-Directory $Layout.backupRoot
  $path = Join-Path $Layout.backupRoot "$Stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  Protect-Directory $path
  $task = Get-ManagedTask
  if ($task) { Assert-ManagedTask $task }
  if ($task) {
    $xml = Export-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath
    Write-Utf8File (Join-Path $path 'task.xml') $xml
    Protect-File (Join-Path $path 'task.xml')
  }
  $hadKey = Test-Path -LiteralPath $Layout.clientKey -PathType Leaf
  if ($hadKey) {
    Copy-Item -LiteralPath $Layout.clientKey -Destination (Join-Path $path 'client-key.txt')
    Protect-File (Join-Path $path 'client-key.txt')
  }
  $snapshot = [ordered]@{
    schema = 'orange5.ae-staff-client-snapshot.v1'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    task = [ordered]@{ existed = [bool]$task; state = if ($task) { [string]$task.State } else { $null }; xml = if ($task) { 'task.xml' } else { $null } }
    clientKey = [ordered]@{ existed = $hadKey; path = $Layout.clientKey; backup = if ($hadKey) { 'client-key.txt' } else { $null }; sha256 = Get-FileSha256 $Layout.clientKey }
  }
  Write-Utf8File (Join-Path $path 'snapshot.json') ((ConvertTo-CompactJson $snapshot) + "`n")
  Protect-File (Join-Path $path 'snapshot.json')
  return $path
}

function Resolve-Snapshot([object]$Layout) {
  if ($SnapshotPath) {
    $candidate = Assert-PathContained $SnapshotPath $Layout.backupRoot 'SnapshotPath'
  } else {
    if (-not (Test-Path -LiteralPath $Layout.backupRoot -PathType Container)) { throw 'No AE Staff client rollback snapshots exist.' }
    $latest = Get-ChildItem -LiteralPath $Layout.backupRoot -Directory | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $latest) { throw 'No AE Staff client rollback snapshots exist.' }
    $candidate = $latest.FullName
  }
  Assert-NoReparsePoint $candidate $Layout.backupRoot 'SnapshotPath'
  $metadata = Join-Path $candidate 'snapshot.json'
  if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { throw "Invalid AE Staff client snapshot: $candidate" }
  return [ordered]@{ path = $candidate; document = (Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json) }
}

function Restore-Snapshot([object]$Layout, [object]$Resolved) {
  $snapshot = $Resolved.document
  if ($snapshot.schema -ne 'orange5.ae-staff-client-snapshot.v1') { throw 'AE Staff client snapshot schema is invalid.' }
  Stop-ManagedTunnel
  $task = Get-ManagedTask
  if ($task) {
    Assert-ManagedTask $task
    Unregister-ScheduledTask -InputObject $task -Confirm:$false
  }
  if ([bool]$snapshot.clientKey.existed) {
    $backup = Assert-PathContained (Join-Path $Resolved.path ([string]$snapshot.clientKey.backup)) $Resolved.path 'Snapshot client key'
    $key = (Get-Content -LiteralPath $backup -Raw).Trim()
    Write-SecureClientKey $Layout.clientKey $key $Layout.stagingRoot
  } elseif (Test-Path -LiteralPath $Layout.clientKey) {
    Remove-Item -LiteralPath $Layout.clientKey -Force
  }
  if ([bool]$snapshot.task.existed) {
    Ensure-TaskFolder
    $xmlPath = Assert-PathContained (Join-Path $Resolved.path ([string]$snapshot.task.xml)) $Resolved.path 'Snapshot task XML'
    Register-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -Xml (Get-Content -LiteralPath $xmlPath -Raw) -Force | Out-Null
    if ([string]$snapshot.task.state -eq 'Running') { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
  }
  return [ordered]@{ snapshotPath = $Resolved.path; restoredTask = [bool]$snapshot.task.existed; restoredTaskState = [string]$snapshot.task.state; restoredClientKey = [bool]$snapshot.clientKey.existed }
}

try {
  Assert-SafeTaskIdentity
  if (-not $ClientKeyPath) { $ClientKeyPath = Join-Path $LocalDataRoot 'secrets\ae-staff-client-key.txt' }
  $LocalDataRoot = Get-FullPath $LocalDataRoot
  $ClientKeyPath = Assert-PathContained $ClientKeyPath $LocalDataRoot 'ClientKeyPath'
  Assert-OutsideGitRepository $ClientKeyPath
  $layout = Get-Layout
  if ($Rollback) {
    $sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
    $script:SshExecutable = if ($sshCommand) { $sshCommand.Source } else { 'ssh.exe' }
  } else {
    $script:SshExecutable = Get-SshExecutable
  }
  $operation = if ($Rollback) { 'rollback' } else { 'provision' }
  $blockers = @()
  if (-not $Rollback) {
    foreach ($required in @($SshKeyPath, $KnownHostsPath)) {
      if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { $blockers += "Missing SSH prerequisite: $required" }
    }
  }

  if (-not $Apply) {
    Write-JsonResult ([ordered]@{
      schema = $Schema
      createdAt = $StartedAt.ToString('o')
      status = 'DRY_RUN'
      mode = $operation
      applyRequired = $true
      target = [ordered]@{ host = $CodexaHost; user = $CodexaUser; remoteKeyPath = $RemoteKeyPath; remotePort = $RemotePort }
      client = [ordered]@{ endpoint = "http://127.0.0.1:$LocalPort"; keyPath = $layout.clientKey; keyOutsideRepository = $true }
      task = [ordered]@{ path = $TaskPath; name = $TaskName; execute = $script:SshExecutable; principal = [Security.Principal.WindowsIdentity]::GetCurrent().Name; logonType = 'S4U'; hidden = $true; runtimePowerShell = $false }
      transport = [ordered]@{ type = 'ssh-loopback-tunnel'; localBind = "127.0.0.1:$LocalPort"; remoteBind = "127.0.0.1:$RemotePort"; strictHostKeyChecking = $true }
      rollbackSnapshot = if ($SnapshotPath) { $SnapshotPath } else { 'latest-protected-local-snapshot' }
      readyToApply = $blockers.Count -eq 0
      blockers = $blockers
      receiptPath = $null
    })
  }

  if ($blockers.Count -gt 0) { throw ($blockers -join '; ') }
  Assert-Administrator

  if ($Rollback) {
    $resolved = Resolve-Snapshot $layout
    $restored = Restore-Snapshot $layout $resolved
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = 'ROLLED_BACK'
      mode = 'rollback'
      host = $env:COMPUTERNAME
      restored = $restored
      serviceVerification = 'prior client state restored; no green runtime claim made'
      receiptPath = $null
    }
    [void](Write-Receipt $layout $receipt)
    Write-JsonResult $receipt
  }

  $remote = Get-RemoteStaffProof
  foreach ($listener in Get-PortListeners) {
    if (-not (Test-ManagedTunnelProcess (Get-ListenerProcess $listener))) {
      throw "Local port $LocalPort is already owned by an unrelated process (pid=$($listener.OwningProcess))."
    }
  }
  $existingTask = Get-ManagedTask
  if ($existingTask) { Assert-ManagedTask $existingTask }
  $listeners = Get-PortListeners
  if ($listeners.Count -gt 0 -and -not $existingTask) {
    throw "Local port $LocalPort has an unmanaged listener; refusing to interrupt another deployment."
  }
  $Script:ActiveSnapshot = New-Snapshot $layout

  try {
    Stop-ManagedTunnel
    $existingTask = Get-ManagedTask
    if ($existingTask) { Unregister-ScheduledTask -InputObject $existingTask -Confirm:$false }
    Write-SecureClientKey $layout.clientKey ([string]$remote.key) $layout.stagingRoot
    $acl = Get-AclProof $layout.clientKey
    if (-not $acl.secure) { throw 'AE Staff client key ACL verification failed.' }
    Register-TunnelTask
    $healthProof = Wait-ClientHealth ([string]$remote.key)
    $taskProof = Get-TaskProof
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = 'PROVISIONED_VERIFIED'
      mode = 'provision'
      host = $env:COMPUTERNAME
      codexa = [ordered]@{ host = $CodexaHost; health = $remote.health; remotePort = $RemotePort }
      client = [ordered]@{ endpoint = "http://127.0.0.1:$LocalPort"; authenticated = $true; health = [ordered]@{ status = [string]$healthProof.health.status; roleCount = [int]$healthProof.health.roleCount }; staff = $healthProof.staff }
      clientKey = [ordered]@{ path = $layout.clientKey; sha256 = Get-TextSha256 ([string]$remote.key); acl = $acl; valueEmitted = $false; matchesOrangeFiveDefault = $layout.clientKey -eq (Get-FullPath (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\secrets\ae-staff-client-key.txt')) }
      transport = [ordered]@{ type = 'ssh-loopback-tunnel'; encrypted = $true; localBind = "127.0.0.1:$LocalPort"; remoteBind = "127.0.0.1:$RemotePort" }
      task = $taskProof
      rollbackSnapshot = $Script:ActiveSnapshot
      rollbackCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File .\provision-ae-staff-client.ps1 -Rollback -Apply -SnapshotPath '$($Script:ActiveSnapshot)'"
      receiptPath = $null
    }
    [void](Write-Receipt $layout $receipt)
    Write-JsonResult $receipt
  } catch {
    $failureMessage = $_.Exception.Message
    $rollbackResult = $null
    $rollbackError = $null
    if ($Script:ActiveSnapshot) {
      try {
        $resolved = [ordered]@{ path = $Script:ActiveSnapshot; document = (Get-Content -LiteralPath (Join-Path $Script:ActiveSnapshot 'snapshot.json') -Raw | ConvertFrom-Json) }
        $rollbackResult = Restore-Snapshot $layout $resolved
      } catch { $rollbackError = $_.Exception.Message }
    }
    $receipt = [ordered]@{
      schema = $Schema
      createdAt = (Get-Date).ToUniversalTime().ToString('o')
      status = if ($rollbackError) { 'FAILED_ROLLBACK_ATTENTION' } else { 'FAILED_ROLLED_BACK' }
      mode = 'provision'
      host = $env:COMPUTERNAME
      error = $failureMessage
      rollbackSnapshot = $Script:ActiveSnapshot
      rollback = $rollbackResult
      rollbackError = $rollbackError
      receiptPath = $null
    }
    try { [void](Write-Receipt $layout $receipt) } catch { }
    Write-JsonResult $receipt 1
  }
} catch {
  Write-JsonResult ([ordered]@{
    schema = $Schema
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    status = 'BLOCKED'
    mode = if ($Rollback) { 'rollback' } else { 'provision' }
    error = $_.Exception.Message
    receiptPath = $null
  }) 1
}
