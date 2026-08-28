# Installs the Orange memory-shadow snapshot as a hidden Bun scheduled task.
# No network, command rail, token, cmd.exe, or child PowerShell is used.

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install')] [switch]$Install,
    [Parameter(ParameterSetName = 'Uninstall')] [switch]$Uninstall,
    [Parameter(ParameterSetName = 'RunNow')] [switch]$RunNow,
    [Parameter(ParameterSetName = 'Status')] [switch]$Status,
    [string]$TaskName = 'Orange5-N150-ShadowSync',
    [string]$BunExe = 'bun.exe',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'sync.mjs'),
    [int]$IntervalMinutes = 60,
    [string]$CacheDir = (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\memory-shadow'),
    [string]$SourceRoot = (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-flux\events')
)

$ErrorActionPreference = 'Stop'

function Resolve-Bun {
    param([string]$Candidate)
    if (Test-Path -LiteralPath $Candidate) { return (Resolve-Path -LiteralPath $Candidate).Path }
    $Command = Get-Command $Candidate -ErrorAction SilentlyContinue
    if ($Command) { return $Command.Source }
    throw 'Bun executable not found. Pass -BunExe explicitly.'
}

function Test-TaskExists {
    $null -ne (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

function Install-ShadowTask {
    if (-not (Test-Path -LiteralPath $ScriptPath)) { throw "sync.mjs not found: $ScriptPath" }
    $Bun = Resolve-Bun $BunExe
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $Arguments = "`"$ScriptPath`" --cache-dir `"$CacheDir`" --source-root `"$SourceRoot`""
    $Action = New-ScheduledTaskAction -Execute $Bun -Argument $Arguments -WorkingDirectory (Split-Path -Parent $ScriptPath)
    $Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $Settings = New-ScheduledTaskSettingsSet -Hidden -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    $Principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description 'Orange local disk memory-shadow snapshot.' -Force | Out-Null
    Write-Host "Installed hidden task: $TaskName"
    Write-Host "Data: $CacheDir"
}

function Remove-ShadowTask {
    if (Test-TaskExists) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed task: $TaskName"
    } else {
        Write-Host "Task is not installed: $TaskName"
    }
}

function Start-ShadowTask {
    if (-not (Test-TaskExists)) { throw "Task is not installed: $TaskName" }
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started task: $TaskName"
}

function Show-ShadowTask {
    if (-not (Test-TaskExists)) {
        Write-Host "Task is not installed: $TaskName"
        return
    }
    $Task = Get-ScheduledTask -TaskName $TaskName
    $Info = Get-ScheduledTaskInfo -TaskName $TaskName
    [pscustomobject]@{
        TaskName = $Task.TaskName
        State = [string]$Task.State
        LastRunTime = $Info.LastRunTime
        LastTaskResult = $Info.LastTaskResult
        NextRunTime = $Info.NextRunTime
        StateFile = (Join-Path $CacheDir '.sync-state.json')
    } | Format-List
}

switch ($PSCmdlet.ParameterSetName) {
    'Install' { Install-ShadowTask }
    'Uninstall' { Remove-ShadowTask }
    'RunNow' { Start-ShadowTask }
    'Status' { Show-ShadowTask }
}
