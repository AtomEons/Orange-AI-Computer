Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$listener = @(Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue)
$processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match '(?i)hermes'
} | ForEach-Object {
  [ordered]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    executable = [string]$_.ExecutablePath
    commandLine = ([string]$_.CommandLine -replace '(?i)(api[_-]?key|token|secret|password)=\S+', '$1=<redacted>')
  }
})

function Get-ActionValue([object]$Action, [string]$Name) {
  $property = $Action.PSObject.Properties[$Name]
  if ($property) { return [string]$property.Value }
  return ''
}

$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {
  $actionText = @($_.Actions | ForEach-Object { "$(Get-ActionValue $_ 'Execute') $(Get-ActionValue $_ 'Arguments') $(Get-ActionValue $_ 'WorkingDirectory')" }) -join ' '
  $_.TaskName -match '(?i)hermes' -or $actionText -match '(?i)hermes'
} | ForEach-Object {
  $info = $_ | Get-ScheduledTaskInfo
  [ordered]@{
    taskPath = $_.TaskPath
    taskName = $_.TaskName
    state = [string]$_.State
    lastRunTime = $info.LastRunTime.ToUniversalTime().ToString('o')
    lastTaskResult = [long]$info.LastTaskResult
    actions = @($_.Actions | ForEach-Object { [ordered]@{ execute = Get-ActionValue $_ 'Execute'; arguments = Get-ActionValue $_ 'Arguments'; workingDirectory = Get-ActionValue $_ 'WorkingDirectory' } })
  }
})

$services = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
  $_.Name -match '(?i)hermes' -or $_.DisplayName -match '(?i)hermes' -or $_.PathName -match '(?i)hermes'
} | ForEach-Object {
  [ordered]@{ name = $_.Name; displayName = $_.DisplayName; state = $_.State; startMode = $_.StartMode; pathName = $_.PathName }
})

[ordered]@{
  schema = 'orange5.hermes-runtime-inspection.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  listener = @($listener | ForEach-Object { [ordered]@{ address = $_.LocalAddress; port = $_.LocalPort; pid = $_.OwningProcess } })
  processes = $processes
  scheduledTasks = $tasks
  services = $services
} | ConvertTo-Json -Depth 10
