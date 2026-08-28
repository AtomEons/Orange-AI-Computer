param(
  [string]$OrangeRoot = 'C:\AtomEons\Orange5',
  [string]$AtomEonsRoot = 'C:\AtomEons'
)

$ErrorActionPreference = 'Stop'
$tools = Join-Path $AtomEonsRoot 'tools\bin'
$runtime = Join-Path $OrangeRoot 'scripts\start-orange5-runtime.ps1'
$supervisor = Join-Path $OrangeRoot 'scripts\orange5-runtime-supervisor.mjs'
$launcherSource = Join-Path $OrangeRoot 'scripts\runtime-services\OrangeFiveHiddenLauncher.cs'
$runtimeWorker = Join-Path $OrangeRoot 'dist\orange5-runtime-worker.exe'
$runtimeExe = Join-Path $OrangeRoot 'dist\orange5-runtime-launcher.exe'
$spine = Join-Path $OrangeRoot '03-BACKEND\spine-cli.mjs'

foreach ($required in @($runtime, $supervisor, $launcherSource, $spine)) {
  if (-not (Test-Path -LiteralPath $required)) {
    throw "Required OrangeFive file is missing: $required"
  }
}

New-Item -ItemType Directory -Force -Path $tools | Out-Null

$health = @'
param([switch]$Json)
$ErrorActionPreference = 'Stop'
$cli = 'C:\AtomEons\Orange5\03-BACKEND\spine-cli.mjs'
if (-not (Test-Path -LiteralPath $cli)) { throw "OrangeFive spine not found at $cli" }
$bun = Get-Command bun -ErrorAction Stop
$arguments = @($cli, '--health')
if ($Json) { $arguments += '--json' }
& $bun.Source @arguments
exit $LASTEXITCODE
'@

$delta = @'
param()
$ErrorActionPreference = 'Stop'
$runtime = 'C:\AtomEons\Orange5\dist\orange5-runtime-launcher.exe'
Write-Warning 'orangebox-delta is retired. Ensuring the OrangeFive runtime instead.'
if (-not (Test-Path -LiteralPath $runtime)) { throw "OrangeFive runtime launcher not found at $runtime" }
& $runtime
exit $LASTEXITCODE
'@

$strongarm = @'
param()
$ErrorActionPreference = 'Stop'
$health = 'C:\AtomEons\tools\bin\orange5-health.ps1'
Write-Warning 'The standalone Delta STRONGARM sidecar is retired from the active route. OrangeFive owns governed pressure, Mirror, and receipt checks.'
if (-not (Test-Path -LiteralPath $health)) { throw "OrangeFive health helper not found at $health" }
& $health
exit $LASTEXITCODE
'@

Set-Content -LiteralPath (Join-Path $tools 'orange5-health.ps1') -Value $health -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tools 'orangebox-delta-backend.ps1') -Value $delta -Encoding UTF8
Set-Content -LiteralPath (Join-Path $tools 'orangebox-strongarm.ps1') -Value $strongarm -Encoding UTF8

$outerIgnore = Join-Path $AtomEonsRoot '.gitignore'
$ignoreRules = @('/Orange5/', '/Orange5-clean-proof/', '/Orange5-github-law-audit/', '/Orange5-worktrees/')
$ignoreText = if (Test-Path -LiteralPath $outerIgnore) { Get-Content -LiteralPath $outerIgnore -Raw } else { '' }
foreach ($rule in $ignoreRules) {
  if ($ignoreText -notmatch "(?m)^$([regex]::Escape($rule))$") {
    Add-Content -LiteralPath $outerIgnore -Value $rule -Encoding UTF8
    $ignoreText += "`n$rule"
  }
}

# One boot authority: a hidden logon task. Remove duplicate startup surfaces.
$startupVbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Orange5 Runtime Hidden.vbs'
if (Test-Path -LiteralPath $startupVbs) { Remove-Item -LiteralPath $startupVbs -Force }
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ((Get-ItemProperty -Path $runKey -Name 'OrangeFiveRuntime' -ErrorAction SilentlyContinue).OrangeFiveRuntime) {
  Remove-ItemProperty -Path $runKey -Name 'OrangeFiveRuntime'
}

$legacyTasks = @(
  'AEorangeBOX Daily Learn',
  'AEorangeBOX Monitor',
  'AtomEons-Codex-Watchdog',
  'Orange4 Stack Watch',
  'Orangebox Delta Active Council Hidden',
  'Orangebox Delta Backend Hidden',
  'Orangebox Delta ChatBackup Hidden',
  'Orangebox Delta Local Llama Hidden',
  'Orangebox Delta Reality Watcher Hidden',
  'Orangebox Delta STRONGARM Hidden',
  'Orange5 Priority Booster Hidden'
)
$legacyTaskState = @()
foreach ($taskName in $legacyTasks) {
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & schtasks.exe /Query /TN $taskName *> $null
    $queryExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($queryExitCode -ne 0) {
    $legacyTaskState += [pscustomobject]@{ name = $taskName; state = 'absent' }
    continue
  }
  try {
    $ErrorActionPreference = 'Continue'
    & schtasks.exe /Change /TN $taskName /Disable *> $null
    $changeExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($changeExitCode -ne 0) { throw "Unable to disable legacy startup task: $taskName" }
  $legacyTaskState += [pscustomobject]@{ name = $taskName; state = 'disabled' }
}

# PowerShell is installer-only. Normal boot enters through a native Windows GUI
# launcher, which applies CREATE_NO_WINDOW before the Bun worker starts.
$bun = (Get-Command bun -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeExe) | Out-Null
& $bun build $supervisor --compile --outfile=$runtimeWorker --windows-title=OrangeFive --windows-publisher=AtomEons --windows-description=OrangeFive_Background_Runtime_Worker --windows-version=5.0.0.0
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $runtimeWorker)) {
  throw 'Unable to compile the OrangeFive runtime worker.'
}
$csc = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $csc) { throw 'Windows C# compiler is unavailable; cannot build the native hidden launcher.' }
& $csc /nologo /target:winexe /optimize+ "/out:$runtimeExe" $launcherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $runtimeExe)) {
  throw 'Unable to compile the OrangeFive native hidden launcher.'
}
$taskName = 'Orange5 Runtime Hidden'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute $runtimeExe -WorkingDirectory $OrangeRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $taskUser
$principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Canonical shell-free OrangeFive native GUI launcher.' -Force | Out-Null

# The old five-minute PowerShell booster caused visible terminal flashes and
# fought the single-specialist model lease governor by repinning a model.
Unregister-ScheduledTask -TaskName 'Orange5 Priority Booster Hidden' -Confirm:$false -ErrorAction SilentlyContinue

$previousRun = (Get-ScheduledTaskInfo -TaskName $taskName).LastRunTime
Start-ScheduledTask -TaskName $taskName
$taskDeadline = (Get-Date).AddMinutes(5)
do {
  Start-Sleep -Milliseconds 250
  $installedTask = Get-ScheduledTask -TaskName $taskName
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
  $taskRan = $taskInfo.LastRunTime -gt $previousRun
} while ((-not $taskRan -or [string]$installedTask.State -eq 'Running') -and (Get-Date) -lt $taskDeadline)
if (-not $taskRan) { throw 'OrangeFive runtime scheduled task did not record a fresh run.' }
if ([string]$installedTask.State -eq 'Running') { throw 'OrangeFive runtime scheduled task exceeded the five-minute installer proof window.' }
if ($taskInfo.LastTaskResult -ne 0) { throw "OrangeFive runtime scheduled task failed with result $($taskInfo.LastTaskResult)." }

& (Join-Path $tools 'orange5-health.ps1')
if ($LASTEXITCODE -ne 0) { throw "OrangeFive health failed with exit code $LASTEXITCODE" }

[pscustomobject]@{
  status = 'VERIFIED'
  orangeRoot = $OrangeRoot
  atomEonsRoot = $AtomEonsRoot
  bootAuthority = 'Scheduled task: Orange5 Runtime Hidden (native GUI launcher with CREATE_NO_WINDOW worker)'
  continuityAuthority = 'Organ health endpoints and receipt logs; no repeating shell task'
  taskUser = $taskUser
  taskLastRunTimeUtc = $taskInfo.LastRunTime.ToUniversalTime().ToString('o')
  taskLastResult = $taskInfo.LastTaskResult
  duplicateStartupRemoved = -not (Test-Path -LiteralPath $startupVbs)
  legacyTasks = $legacyTaskState
  installedHelpers = @(
    (Join-Path $tools 'orange5-health.ps1'),
    (Join-Path $tools 'orangebox-delta-backend.ps1'),
    (Join-Path $tools 'orangebox-strongarm.ps1')
  )
} | ConvertTo-Json -Depth 4
