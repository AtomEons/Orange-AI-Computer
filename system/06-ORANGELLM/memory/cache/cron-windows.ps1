# cron-windows.ps1 — Install the hourly N150 shadow-cache sync as a Windows Scheduled Task.
#
# Usage (run elevated PowerShell):
#   .\cron-windows.ps1 -Install
#   .\cron-windows.ps1 -Uninstall
#   .\cron-windows.ps1 -RunNow
#   .\cron-windows.ps1 -Status
#
# Requires:
#   - Node 20+ on PATH (or pass -NodeExe "C:\Path\to\node.exe")
#   - $env:ORANGEBOX_RAIL_TOKEN set in the SYSTEM or USER context the task runs as.
#     Recommended: set it as a machine-level env var via:
#       [Environment]::SetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN','<token>','Machine')
#     then re-run -Install so the task picks it up.
#
# Schedule: every 60 minutes, starting 2 minutes after install. RunOnlyIfNetworkAvailable.
# Freshness SLA: 1 hour. Stale at >2 hours (see shadow-reader.mjs).

[CmdletBinding(DefaultParameterSetName = 'Install')]
param(
    [Parameter(ParameterSetName = 'Install')]   [switch]$Install,
    [Parameter(ParameterSetName = 'Uninstall')] [switch]$Uninstall,
    [Parameter(ParameterSetName = 'RunNow')]    [switch]$RunNow,
    [Parameter(ParameterSetName = 'Status')]    [switch]$Status,

    [string]$TaskName = 'Orange5-N150-ShadowSync',
    [string]$NodeExe  = 'node.exe',
    [string]$ScriptPath = (Join-Path $PSScriptRoot 'sync.mjs'),
    [int]   $IntervalMinutes = 60,
    [string]$LogFile = (Join-Path $PSScriptRoot 'sync.log')
)

$ErrorActionPreference = 'Stop'

function Resolve-NodeExe {
    param([string]$Candidate)
    if (Test-Path $Candidate) { return (Resolve-Path $Candidate).Path }
    $cmd = Get-Command $Candidate -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    throw "node executable not found. Pass -NodeExe explicitly."
}

function Get-TaskExists {
    param([string]$Name)
    $null -ne (Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue)
}

function Do-Install {
    if (-not (Test-Path $ScriptPath)) {
        throw "sync.mjs not found at $ScriptPath"
    }
    $node = Resolve-NodeExe -Candidate $NodeExe
    $workDir = Split-Path -Parent $ScriptPath

    # We wrap node in cmd.exe so we can redirect stdout/stderr to a rotating log.
    # Task Scheduler does not append; we use >> via cmd /c.
    $argLine = "/c `"`"$node`" `"$ScriptPath`" >> `"$LogFile`" 2>&1`""

    $action = New-ScheduledTaskAction `
        -Execute 'cmd.exe' `
        -Argument $argLine `
        -WorkingDirectory $workDir

    $start = (Get-Date).AddMinutes(2)
    $trigger = New-ScheduledTaskTrigger -Once -At $start `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RunOnlyIfNetworkAvailable `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    # Run as SYSTEM so the task does not depend on an interactive logon.
    # If the rail token is only in a user-scope env var, switch to that user instead.
    $principal = New-ScheduledTaskPrincipal `
        -UserId 'SYSTEM' `
        -LogonType ServiceAccount `
        -RunLevel Highest

    if (Get-TaskExists -Name $TaskName) {
        Write-Host "Updating existing task '$TaskName'"
        Set-ScheduledTask -TaskName $TaskName `
            -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
    } else {
        Write-Host "Registering new task '$TaskName'"
        Register-ScheduledTask -TaskName $TaskName `
            -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
            -Description 'Orange5 N150 shadow-cache hourly sync from Codexa rail (Mirage memory plane).' | Out-Null
    }

    Write-Host "Installed. First run at $start, then every $IntervalMinutes minute(s)."
    Write-Host "Log: $LogFile"
    Write-Host ""
    Write-Host "REMINDER: ORANGEBOX_RAIL_TOKEN must be readable by the task principal (SYSTEM by default)."
    Write-Host "Set machine-wide with:"
    Write-Host "  [Environment]::SetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN','<token>','Machine')"
}

function Do-Uninstall {
    if (Get-TaskExists -Name $TaskName) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed task '$TaskName'."
    } else {
        Write-Host "Task '$TaskName' not present. Nothing to do."
    }
}

function Do-RunNow {
    if (-not (Get-TaskExists -Name $TaskName)) {
        throw "Task '$TaskName' not installed. Run -Install first."
    }
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Triggered '$TaskName'. Tail the log:"
    Write-Host "  Get-Content -Path '$LogFile' -Tail 50 -Wait"
}

function Do-Status {
    if (-not (Get-TaskExists -Name $TaskName)) {
        Write-Host "Task '$TaskName' is NOT installed."
        return
    }
    $task = Get-ScheduledTask -TaskName $TaskName
    $info = Get-ScheduledTaskInfo -TaskName $TaskName
    Write-Host "Task:          $($task.TaskName)"
    Write-Host "State:         $($task.State)"
    Write-Host "LastRunTime:   $($info.LastRunTime)"
    Write-Host "LastResult:    0x$('{0:X8}' -f $info.LastTaskResult)  ($($info.LastTaskResult))"
    Write-Host "NextRunTime:   $($info.NextRunTime)"
    $stateFile = Join-Path $PSScriptRoot '.sync-state.json'
    if (Test-Path $stateFile) {
        $s = Get-Content $stateFile -Raw | ConvertFrom-Json
        Write-Host "last_run_at:   $($s.last_run_at)"
        $ageMs = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) - $s.last_run_ms
        $ageMin = [math]::Round($ageMs / 60000, 1)
        Write-Host "age_minutes:   $ageMin"
        if ($ageMin -gt 120) { Write-Host "freshness:     STALE (>2h)" -ForegroundColor Red }
        elseif ($ageMin -gt 60) { Write-Host "freshness:     AGING (>1h)" -ForegroundColor Yellow }
        else { Write-Host "freshness:     FRESH" -ForegroundColor Green }
    } else {
        Write-Host "No .sync-state.json yet — task has not produced a successful sync."
    }
}

switch ($PSCmdlet.ParameterSetName) {
    'Install'   { Do-Install }
    'Uninstall' { Do-Uninstall }
    'RunNow'    { Do-RunNow }
    'Status'    { Do-Status }
}
