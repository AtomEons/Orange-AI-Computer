param(
  [string]$OrangeRoot = 'C:\AtomEons\Orange5',
  [string]$DataRoot = 'C:\Users\Atom\OrangeBox-Data\orange5',
  [string]$BunPath = 'C:\Users\Atom\.bun\bin\bun.exe',
  [string]$TaskName = 'Orange5 AE Pulse Carrier'
)

$ErrorActionPreference = 'Stop'
$launcher = Join-Path $OrangeRoot 'scripts\ae-pulse-service-launcher.mjs'
$keyFile = Join-Path $DataRoot 'secrets\ae-pulse-key.txt'

foreach ($required in @($BunPath, $launcher, $keyFile)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "AE Pulse prerequisite missing: $required"
  }
}

$action = New-ScheduledTaskAction `
  -Execute $BunPath `
  -Argument ('"{0}" server --data-root "{1}"' -f $launcher, $DataRoot) `
  -WorkingDirectory $OrangeRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -User 'SYSTEM' `
  -RunLevel Highest `
  -Force | Out-Null

[pscustomobject]@{
  schema = 'orange.ae-pulse.task-install.v1'
  ok = $true
  taskName = $TaskName
  executable = $BunPath
  launcher = $launcher
  dataRoot = $DataRoot
  runAs = 'SYSTEM'
} | ConvertTo-Json -Depth 4
