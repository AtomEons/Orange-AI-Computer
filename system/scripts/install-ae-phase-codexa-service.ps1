param(
  [string]$OrangeRoot = 'C:\AtomEons\Orange5',
  [string]$DataRoot = 'C:\Users\Atom\OrangeBox-Data\orange5',
  [string]$BunPath = 'C:\Users\Atom\.bun\bin\bun.exe'
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Orange5 AE Phase Fabric'
$FirewallName = 'Orange5 AE Phase Fabric'
$launcher = Join-Path $OrangeRoot 'scripts\ae-phase-service-launcher.mjs'
$backend = Join-Path $OrangeRoot '03-BACKEND\ae-phase-fabric.mjs'
$keyFile = Join-Path $DataRoot 'secrets\ae-phase-key.txt'

foreach ($required in @($BunPath, $launcher, $backend, $keyFile)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "AE Phase Fabric prerequisite missing: $required"
  }
}

$key = (Get-Content -LiteralPath $keyFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($key)) {
  throw "AE Phase Fabric key is empty: $keyFile"
}

$bunVersion = (& $BunPath --version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($bunVersion)) {
  throw "Bun validation failed: $BunPath"
}

$action = New-ScheduledTaskAction `
  -Execute $BunPath `
  -Argument ('"{0}" server --data-root "{1}" --key-file "{2}"' -f $launcher, $DataRoot, $keyFile) `
  -WorkingDirectory $OrangeRoot
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

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $TaskName
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      if (-not $client.ConnectAsync('127.0.0.1', 8907).Wait(200)) { break }
    } catch { break }
    finally { $client.Dispose() }
    Start-Sleep -Milliseconds 250
  }
}

# Direct Bun execution under noninteractive SYSTEM keeps runtime windowless.
# This task name is distinct from Orange5 AE Pulse Carrier; no Pulse task is altered.
Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User 'SYSTEM' `
  -RunLevel Highest `
  -Force | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $FirewallName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName $FirewallName `
    -Direction Inbound `
    -Protocol UDP `
    -LocalPort 8905 `
    -Action Allow `
    -Profile Any | Out-Null
} else {
  Set-NetFirewallRule -DisplayName $FirewallName -Enabled True -Profile Any -Action Allow
}

Get-NetFirewallRule -DisplayName 'Orange5 AE Phase Proof' -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 2
$task = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
if ($task.State -ne 'Running') {
  throw "AE Phase Fabric task failed to remain running; result=$($taskInfo.LastTaskResult)"
}

$LegacyTaskName = 'Orange5 AE Pulse Carrier'
$legacyTask = Get-ScheduledTask -TaskName $LegacyTaskName -ErrorAction SilentlyContinue
if ($legacyTask) {
  if ($legacyTask.State -eq 'Running') { Stop-ScheduledTask -TaskName $LegacyTaskName }
  Unregister-ScheduledTask -TaskName $LegacyTaskName -Confirm:$false
}
Get-NetFirewallRule -DisplayName $LegacyTaskName -ErrorAction SilentlyContinue |
  Remove-NetFirewallRule -ErrorAction SilentlyContinue

[pscustomobject]@{
  schema = 'orange.ae-phase.task-install.v1'
  ok = $true
  taskName = $TaskName
  executable = $BunPath
  bunVersion = $bunVersion
  launcher = $launcher
  backend = $backend
  keyFile = $keyFile
  dataRoot = $DataRoot
  runAs = 'SYSTEM'
  hidden = $true
  rebootPersistent = $true
  runtimeShell = $false
  firewall = $FirewallName
  started = $true
  state = $task.State.ToString()
  lastTaskResult = $taskInfo.LastTaskResult
  legacyPulseTaskRemoved = $null -ne $legacyTask
} | ConvertTo-Json -Depth 4
