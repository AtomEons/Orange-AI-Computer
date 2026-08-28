[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\superdirectory'),
  [string]$TaskName = 'OrangeFive-Superdirectory'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Entry = Join-Path $ProjectRoot '03-BACKEND\transcript-archive-daemon.mjs'
$LauncherSource = Join-Path $ProjectRoot 'scripts\runtime-services\OrangeFiveHiddenLauncher.cs'
$BinRoot = Join-Path $Root 'bin'
$Exe = Join-Path $BinRoot 'orange-superdirectory-daemon.exe'
$Status = Join-Path $Root 'daemon-status.json'
$Bun = (Get-Command bun.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $BinRoot | Out-Null

# Put CREATE_NO_WINDOW in a native GUI-subsystem parent before Bun starts.
# Running the source entry also avoids compiled import.meta.main ambiguity.
$Csc = @(
  "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe",
  "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Csc) { throw 'Windows C# compiler is unavailable; cannot build the native hidden launcher.' }
& $Csc /nologo /target:winexe /optimize+ "/out:$Exe" $LauncherSource
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Exe)) {
  throw 'OrangeFive Superdirectory native hidden launcher compilation failed.'
}

# Raw transcripts may contain credentials the operator pasted into a chat.
# Keep the archive private to the current Windows account and SYSTEM.
& icacls.exe $Root /inheritance:r | Out-Null
& icacls.exe $Root /grant:r "${env:USERNAME}:(OI)(CI)F" 'SYSTEM:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not apply private Superdirectory ACL.' }

$ActionArguments = "`"$Bun`" `"$Entry`" `"$ProjectRoot`""
$Action = New-ScheduledTaskAction -Execute $Exe -Argument $ActionArguments -WorkingDirectory $ProjectRoot
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings `
  -Description 'Orange AI Computer OS disk-native transcript and Markdown continuity organ.' -Force | Out-Null
Remove-Item -LiteralPath $Status -Force -ErrorAction SilentlyContinue
$InstallStarted = Get-Date
Start-ScheduledTask -TaskName $TaskName
# Defender and a busy N150 can delay first process creation well beyond ten
# seconds. Keep the proof bounded while allowing the native child to start.
for ($Attempt = 0; $Attempt -lt 180 -and -not (Test-Path -LiteralPath $Status); $Attempt++) {
  Start-Sleep -Milliseconds 500
}

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
$Daemon = if (Test-Path -LiteralPath $Status) { Get-Content -LiteralPath $Status -Raw | ConvertFrom-Json } else { $null }
$TaskRunning = [string]$Task.State -eq 'Running'
$DaemonFresh = $null -ne $Daemon -and ([datetime]$Daemon.written_at).ToUniversalTime() -ge $InstallStarted.ToUniversalTime().AddSeconds(-1)
$DaemonProcess = if ($null -ne $Daemon) { Get-Process -Id ([int]$Daemon.pid) -ErrorAction SilentlyContinue } else { $null }
$DaemonPathMatches = $null -ne $DaemonProcess -and $DaemonProcess.Path -ieq $Bun
$DaemonHealthy = $DaemonFresh -and $DaemonPathMatches -and $Daemon.status -notin @('ERROR','FATAL')
$Result = [ordered]@{
  schema = 'orange5.superdirectory.windows-install.v1'
  status = if ($TaskRunning -and $DaemonHealthy) { 'GREEN' } else { 'NEEDS_WORK' }
  task = $TaskName
  task_state = [string]$Task.State
  last_task_result = $Info.LastTaskResult
  executable = $Exe
  executable_sha256 = (Get-FileHash -LiteralPath $Exe -Algorithm SHA256).Hash.ToLowerInvariant()
  worker_executable = $Bun
  worker_entry = $Entry
  worker_entry_sha256 = (Get-FileHash -LiteralPath $Entry -Algorithm SHA256).Hash.ToLowerInvariant()
  hidden_console = $true
  hidden_mechanism = 'native GUI launcher plus CREATE_NO_WINDOW worker'
  data_root = $Root
  daemon_status = $Daemon
  proof = [ordered]@{
    task_running = $TaskRunning
    daemon_fresh = $DaemonFresh
    daemon_process_exists = $null -ne $DaemonProcess
    daemon_path_matches = $DaemonPathMatches
    daemon_non_error_status = $null -ne $Daemon -and $Daemon.status -notin @('ERROR','FATAL')
  }
  generated_at = (Get-Date).ToUniversalTime().ToString('o')
}
$Receipt = Join-Path $Root 'windows-install-receipt.json'
$Result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Receipt -Encoding utf8
$Result.receipt_path = $Receipt
$Result | ConvertTo-Json -Depth 12
if ($Result.status -ne 'GREEN') { exit 1 }
