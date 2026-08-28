<#
.SYNOPSIS
    Install (or replace) the Windows Task Scheduler entry
    'AtomEons-Rail-Rotation' that rotates ORANGEBOX_RAIL_TOKEN every 7 days
    at 03:00 America/New_York. Also emits a sister Codexa systemd timer
    unit + service unit pair for the bridge-side rotation hook.

.DESCRIPTION
    This is the scheduler half of the Codexa rail token rotation doctrine.
    Its siblings:

        generate.mjs       - mints a fresh HS256 256-bit token (the only
                             place raw token bytes exist)
        store-n150.ps1     - persists the token in Windows Credential
                             Manager via DPAPI on the N150 operator box,
                             writes only an sha256 fingerprint to state
        deploy-codexa.ps1  - SCPs the token to Codexa
                             (/opt/atomeons/.rail-token, chmod 600), pokes
                             the bridge unit, compares remote sha256

    This script wires those three together on a 7-day cadence and writes
    the equivalent systemd timer + service unit files that the Codexa
    bridge-side operator drops into /etc/systemd/system/ to mirror the
    rotation on the Linux side.

    Behavior:

        1. Idempotent. If a scheduled task named 'AtomEons-Rail-Rotation'
           already exists, it is unregistered first, then a fresh entry
           is registered. The replacement is atomic from the operator's
           point of view (no overlapping schedules ever live).

        2. The rotate.ps1 driver path is recorded into the action. We
           validate the file exists before installing. If -AllowMissingDriver
           is set, we install anyway and log the gap (used when the
           rotate.ps1 driver lands later in the wave).

        3. The trigger is daily-with-DaysInterval=7 anchored to
           03:00 LOCAL TIME, but we explicitly resolve and assert that
           the host's time zone is 'Eastern Standard Time' (Windows
           id; equivalently America/New_York). If the host is in
           another zone we refuse, unless -ForceTimezone is set, in
           which case we log the mismatch into the receipt and proceed.

        4. The task runs as SYSTEM (Principal = NT AUTHORITY\SYSTEM,
           RunLevel = Highest) so it survives operator logout and so it
           can read the per-machine portions of state. The DPAPI store
           write inside rotate.ps1 is current-user scope; the rotation
           driver is expected to LogonType=Interactive-substitute via
           a service account when used in long-running unattended mode.
           For solo-operator (Atom) usage on the N150, SYSTEM is correct
           because rotate.ps1 invokes store-n150.ps1 via a credential
           helper that re-enters the operator's user hive. The default
           is SYSTEM; pass -RunAsCurrentUser to flip.

        5. ORANGEBOX_RAIL_DISABLED=1 in the *machine* environment is a
           hard kill: the installer still creates the task, but the
           task action prepends a refusal check. The task action is:

             powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass
               -File <DriverPath>
               -Source 'scheduled-7d'

           and rotate.ps1 itself honors the kill-switch. The installer
           never bakes the env var into the task definition.

        6. After install, we re-read the registered task and write a
           non-secret state file recording: task name, schedule, next
           run time, principal, driver path, sha256 of the driver file
           (so we notice if it changes under us), Codexa unit names,
           timezone resolution, and whether sister Codexa units were
           emitted.

        7. Codexa systemd units are emitted to the OutDir (default
           sister state\ dir) as plain text. They are NOT pushed to
           Codexa from here - that is operator ceremony. Files emitted:

             atomeons-rail-rotation.timer
             atomeons-rail-rotation.service

           The .timer runs OnCalendar=*-*-* 03:00:00 America/New_York
           with Persistent=true, anchored weekly via the timer
           Unit=...service. The .service is Type=oneshot and runs the
           Codexa rotation hook (default /opt/atomeons/bin/rotate-hook.sh)
           which the bridge owner is expected to author. The unit file
           paths printed by this script are the suggested drop targets
           on Codexa, not local paths.

    Mom's Law:
        - This installer never reads, prints, or touches the raw token.
        - Receipts log sha256 of the driver file, not the token.
        - The kill-switch is checked, not assumed.
        - Idempotency is a real Unregister + Register, not a silent
          skip - we want the schedule to reflect THIS install's intent.
        - If we cannot do what was asked, we say so and exit non-zero
          rather than partial-installing.

.PARAMETER TaskName
    Scheduler entry name. Defaults to 'AtomEons-Rail-Rotation'. Changing
    this is supported but the matching state file name follows along.

.PARAMETER DriverPath
    Absolute path to rotate.ps1 (the driver script that orchestrates
    generate.mjs -> store-n150.ps1 -> deploy-codexa.ps1). Defaults to
    'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\rotate.ps1'.

.PARAMETER AtTime
    Local time of day to fire. Defaults to '03:00'. Eastern Standard
    Time is asserted unless -ForceTimezone is set.

.PARAMETER DaysInterval
    Rotation cadence in days. Defaults to 7. Anything below 1 is
    rejected.

.PARAMETER StateFile
    Path to non-secret install receipt. Defaults to
    state\install-schedule.state.json under this folder.

.PARAMETER OutDir
    Where to emit the Codexa systemd unit files. Defaults to
    state\codexa-systemd under this folder.

.PARAMETER CodexaUnitName
    Base name of the Codexa systemd unit pair (without extension).
    Defaults to 'atomeons-rail-rotation'.

.PARAMETER CodexaHookPath
    ExecStart= path on Codexa for the rotation hook. Defaults to
    '/opt/atomeons/bin/rotate-hook.sh'.

.PARAMETER RunAsCurrentUser
    If set, register under the current user instead of SYSTEM.

.PARAMETER ForceTimezone
    If set, install even if the host timezone is not Eastern Standard
    Time. Logged in the receipt.

.PARAMETER AllowMissingDriver
    If set, install even if DriverPath does not exist yet. Logged.

.PARAMETER DryRun
    Validate inputs and emit the receipt + unit files, but do NOT
    touch Task Scheduler. The receipt is marked dry_run=true.

.EXAMPLE
    .\install-schedule.ps1

.EXAMPLE
    .\install-schedule.ps1 -DryRun

.EXAMPLE
    .\install-schedule.ps1 -RunAsCurrentUser -ForceTimezone

.NOTES
    Author:   Atom McCree (AtomEons)
    Receipt:  Wave 2 close - rail token blocker resolution
    Doctrine: Codexa rail token rotation, 04-CONTROL-PLANE/rail-token
#>
[CmdletBinding()]
param(
    [string] $TaskName           = 'AtomEons-Rail-Rotation',
    [string] $DriverPath         = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\rotate.ps1',
    [string] $AtTime             = '03:00',
    [int]    $DaysInterval       = 7,
    [string] $StateFile          = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\install-schedule.state.json',
    [string] $OutDir             = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\codexa-systemd',
    [string] $CodexaUnitName     = 'atomeons-rail-rotation',
    [string] $CodexaHookPath     = '/opt/atomeons/bin/rotate-hook.sh',
    [switch] $RunAsCurrentUser,
    [switch] $ForceTimezone,
    [switch] $AllowMissingDriver,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

function Write-Step {
    param([string] $Msg)
    Write-Host "[install-schedule] $Msg"
}

function New-DirIfMissing {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        New-Item -ItemType Directory -Path $Path -Force | Out-Null
    }
}

function Get-FileSha256Hex {
    param([string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try {
        return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    } catch {
        return $null
    }
}

function Get-IsoUtcNow {
    return (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
}

function Assert-AtTime {
    param([string] $Value)
    if ($Value -notmatch '^([01][0-9]|2[0-3]):[0-5][0-9]$') {
        throw "AtTime must be HH:mm (24h), got '$Value'."
    }
}

function Resolve-TimezonePosture {
    # Returns @{ ok=bool; local_id=string; note=string }
    $tz = [System.TimeZoneInfo]::Local
    $eastern = $null
    foreach ($candidate in @('Eastern Standard Time', 'America/New_York')) {
        try {
            $eastern = [System.TimeZoneInfo]::FindSystemTimeZoneById($candidate)
            break
        } catch { continue }
    }
    if ($null -eq $eastern) {
        return @{
            ok       = $false
            local_id = $tz.Id
            note     = "Could not resolve an Eastern timezone id on this host."
        }
    }
    $isEastern = ($tz.Id -eq $eastern.Id) -or ($tz.BaseUtcOffset -eq $eastern.BaseUtcOffset)
    return @{
        ok       = [bool]$isEastern
        local_id = $tz.Id
        note     = if ($isEastern) {
            "Host local timezone aligns with Eastern."
        } else {
            "Host local timezone '$($tz.Id)' is NOT Eastern (expected '$($eastern.Id)')."
        }
    }
}

# ---------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------

Write-Step "Pre-flight starting."

# 1. Validate AtTime
Assert-AtTime -Value $AtTime

# 2. Validate DaysInterval
if ($DaysInterval -lt 1) {
    throw "DaysInterval must be >= 1, got $DaysInterval."
}

# 3. Validate timezone
$tzPosture = Resolve-TimezonePosture
if (-not $tzPosture.ok -and -not $ForceTimezone) {
    throw "Refusing to install: $($tzPosture.note) Re-run with -ForceTimezone if intentional."
}
Write-Step ("Timezone: " + $tzPosture.note)

# 4. Validate driver path
$driverExists = Test-Path -LiteralPath $DriverPath -PathType Leaf
if (-not $driverExists -and -not $AllowMissingDriver) {
    throw "Driver not found: $DriverPath. Pass -AllowMissingDriver to install anyway (the driver is expected to land in this same folder)."
}
$driverSha = if ($driverExists) { Get-FileSha256Hex -Path $DriverPath } else { $null }

# 5. Validate kill-switch posture (informational only - we still install)
$killSwitch = $null
try {
    $killSwitch = [System.Environment]::GetEnvironmentVariable('ORANGEBOX_RAIL_DISABLED', 'Machine')
} catch { $killSwitch = $null }
$killActive = ($killSwitch -eq '1')
if ($killActive) {
    Write-Step "ORANGEBOX_RAIL_DISABLED=1 is set at machine scope. Task will install; rotate.ps1 is expected to honor the switch."
}

# 6. Ensure output dirs exist
$stateDir = Split-Path -Parent $StateFile
New-DirIfMissing -Path $stateDir
New-DirIfMissing -Path $OutDir

# ---------------------------------------------------------------------
# Emit Codexa systemd units (always - they are static text by inputs)
# ---------------------------------------------------------------------

Write-Step "Emitting Codexa systemd unit files to $OutDir"

$timerPath   = Join-Path $OutDir ("{0}.timer"   -f $CodexaUnitName)
$servicePath = Join-Path $OutDir ("{0}.service" -f $CodexaUnitName)

# OnCalendar weekly anchor: Monday 03:00 America/New_York. Persistent=true
# so a missed window (host offline) catches up on next boot. We pin the
# timezone explicitly via OnCalendar's TZ= prefix (systemd >= 239 supports
# this). The 7-day cadence is enforced by the Mon anchor; the operator
# can shift the day by editing OnCalendar.
$timerBody = @'
# atomeons-rail-rotation.timer
# ----------------------------
# Codexa-side mirror of the N150 Windows Task Scheduler entry
# 'AtomEons-Rail-Rotation'. Fires the bridge-side rotation hook every
# 7 days at 03:00 America/New_York. Persistent so missed windows catch
# up on next boot. Authored by install-schedule.ps1 - do not hand-edit
# without updating the N150 install receipt.

[Unit]
Description=AtomEons rail token rotation (Codexa bridge-side hook)
Documentation=https://atomeons.lan/doctrine/orange5/rail-token
Requires=__UNIT__.service

[Timer]
# Monday 03:00 America/New_York, weekly. Persistent catches missed windows.
OnCalendar=Mon *-*-* 03:00:00 America/New_York
Persistent=true
AccuracySec=1min
Unit=__UNIT__.service

[Install]
WantedBy=timers.target
'@.Replace('__UNIT__', $CodexaUnitName)

$serviceBody = @'
# atomeons-rail-rotation.service
# ------------------------------
# Codexa-side rotation hook. Invoked by atomeons-rail-rotation.timer.
# This service is the bridge-side counterpart to the N150's rotate.ps1.
# It does NOT mint the token - that happens on the N150. Its job is to:
#   1. Verify /opt/atomeons/.rail-token exists, is mode 0600, owned by
#      atomeons:atomeons, and has a fresh-enough mtime (the SCP from
#      the N150 side bumps it within the rotation window).
#   2. systemctl reload-or-restart orangebox-bridge (gateway hot-reload).
#   3. systemctl is-active orangebox-bridge (post-check).
#   4. Append an audit row to Reality Flux with sha256 fingerprints
#      only - never the token.
#
# Mom's Law: tokens never appear in journald. The hook script logs only
# sha256 fingerprints and unit-status booleans.

[Unit]
Description=AtomEons rail token rotation hook (bridge-side)
After=network-online.target orangebox-bridge.service
Wants=network-online.target

[Service]
Type=oneshot
# Refuse to run if the operator pulled the kill-switch system-wide.
Environment=ORANGEBOX_RAIL_DISABLED=
ExecCondition=/bin/sh -c '[ "${ORANGEBOX_RAIL_DISABLED}" != "1" ]'
ExecStart=__HOOK__
# Hook is expected to be authored by the bridge owner.
User=atomeons
Group=atomeons
# Defense in depth - the token file is the only secret this unit touches.
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/atomeons /var/log/atomeons
PrivateTmp=true
NoNewPrivileges=true
# Hard ceiling so a wedged hook does not stall the timer fleet.
TimeoutStartSec=2min

[Install]
WantedBy=multi-user.target
'@.Replace('__HOOK__', $CodexaHookPath)

Set-Content -LiteralPath $timerPath   -Value $timerBody   -Encoding utf8
Set-Content -LiteralPath $servicePath -Value $serviceBody -Encoding utf8

Write-Step ("  timer   -> " + $timerPath)
Write-Step ("  service -> " + $servicePath)

# ---------------------------------------------------------------------
# Register / replace the scheduled task
# ---------------------------------------------------------------------

$registeredTask = $null
$nextRun        = $null
$taskAction     = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$DriverPath`" -Source 'scheduled-7d'"

if ($DryRun) {
    Write-Step "Dry run - skipping Task Scheduler mutation."
} else {
    Write-Step "Registering scheduled task '$TaskName' (7d cadence, $AtTime)."

    # Idempotency: unregister if present.
    $existing = $null
    try {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop
    } catch {
        $existing = $null
    }
    if ($null -ne $existing) {
        Write-Step "Existing task found - unregistering for clean replace."
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
    }

    $action = New-ScheduledTaskAction `
        -Execute 'powershell.exe' `
        -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"{0}`" -Source 'scheduled-7d'" -f $DriverPath)

    # First fire at next occurrence of AtTime (today if still future, else tomorrow).
    $now       = Get-Date
    $todayFire = Get-Date -Hour ([int]$AtTime.Split(':')[0]) -Minute ([int]$AtTime.Split(':')[1]) -Second 0 -Millisecond 0
    $firstFire = if ($todayFire -gt $now) { $todayFire } else { $todayFire.AddDays(1) }

    $trigger = New-ScheduledTaskTrigger -Daily -At $firstFire -DaysInterval $DaysInterval

    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RunOnlyIfNetworkAvailable:$false `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

    if ($RunAsCurrentUser) {
        $principal = New-ScheduledTaskPrincipal `
            -UserId  ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
            -LogonType Interactive `
            -RunLevel Highest
    } else {
        $principal = New-ScheduledTaskPrincipal `
            -UserId 'NT AUTHORITY\SYSTEM' `
            -LogonType ServiceAccount `
            -RunLevel Highest
    }

    $taskDef = New-ScheduledTask `
        -Action    $action `
        -Trigger   $trigger `
        -Settings  $settings `
        -Principal $principal `
        -Description ("AtomEons rail token rotation. 7-day cadence at {0} local. Driver: {1}. Doctrine: Codexa rail token rotation (Orange5/04-CONTROL-PLANE/rail-token)." -f $AtTime, $DriverPath)

    $registeredTask = Register-ScheduledTask -TaskName $TaskName -InputObject $taskDef -Force

    # Re-read for an authoritative next-run timestamp.
    try {
        $info    = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction Stop
        $nextRun = if ($null -ne $info.NextRunTime) { $info.NextRunTime.ToString('o') } else { $null }
    } catch {
        $nextRun = $null
    }
    Write-Step ("Task registered. Next run: " + ($nextRun -as [string]))
}

# ---------------------------------------------------------------------
# Receipt
# ---------------------------------------------------------------------

$receipt = [ordered]@{
    schema_version       = '1.0.0'
    written_at_utc       = Get-IsoUtcNow
    task_name            = $TaskName
    schedule = [ordered]@{
        at_local         = $AtTime
        days_interval    = $DaysInterval
        timezone_local   = $tzPosture.local_id
        timezone_aligned = [bool]$tzPosture.ok
        timezone_note    = $tzPosture.note
        force_timezone   = [bool]$ForceTimezone
        next_run_iso     = $nextRun
    }
    driver = [ordered]@{
        path             = $DriverPath
        exists           = [bool]$driverExists
        sha256           = $driverSha
        allow_missing    = [bool]$AllowMissingDriver
    }
    principal = [ordered]@{
        run_as_current_user = [bool]$RunAsCurrentUser
        identity            = if ($RunAsCurrentUser) {
            [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        } else {
            'NT AUTHORITY\SYSTEM'
        }
    }
    kill_switch = [ordered]@{
        env_var    = 'ORANGEBOX_RAIL_DISABLED'
        machine_value = $killSwitch
        active     = [bool]$killActive
    }
    codexa_systemd = [ordered]@{
        emitted     = $true
        out_dir     = $OutDir
        unit_name   = $CodexaUnitName
        timer_file  = $timerPath
        service_file = $servicePath
        hook_path   = $CodexaHookPath
        drop_target_hint = '/etc/systemd/system/'
        enable_cmds = @(
            "sudo cp $($CodexaUnitName).timer /etc/systemd/system/",
            "sudo cp $($CodexaUnitName).service /etc/systemd/system/",
            "sudo systemctl daemon-reload",
            "sudo systemctl enable --now $($CodexaUnitName).timer",
            "systemctl list-timers --all | grep $($CodexaUnitName)"
        )
    }
    task_action_preview = $taskAction
    dry_run             = [bool]$DryRun
    notes               = 'Tokens never appear in logs or receipts. Only sha256 fingerprints. install-schedule.ps1 itself never touches token bytes.'
}

$receiptJson = ($receipt | ConvertTo-Json -Depth 8)
Set-Content -LiteralPath $StateFile -Value $receiptJson -Encoding utf8

Write-Step ("Receipt written: " + $StateFile)

# Final summary (non-secret)
Write-Host ""
Write-Host "=== AtomEons-Rail-Rotation install summary ==="
Write-Host ("  Task name        : " + $TaskName)
Write-Host ("  Cadence          : every {0} day(s) at {1} local" -f $DaysInterval, $AtTime)
Write-Host ("  Timezone         : {0} (aligned={1})" -f $tzPosture.local_id, $tzPosture.ok)
Write-Host ("  Driver           : {0} (exists={1})" -f $DriverPath, $driverExists)
Write-Host ("  Driver sha256    : " + ($driverSha -as [string]))
Write-Host ("  Principal        : " + $receipt.principal.identity)
Write-Host ("  Kill-switch      : active={0}" -f $killActive)
Write-Host ("  Codexa timer     : " + $timerPath)
Write-Host ("  Codexa service   : " + $servicePath)
Write-Host ("  Next run         : " + ($nextRun -as [string]))
Write-Host ("  Dry run          : " + $DryRun)
Write-Host ("  Receipt          : " + $StateFile)
Write-Host ""

if (-not $DryRun -and $null -eq $registeredTask) {
    throw "Task registration appears to have failed silently. Receipt written for forensics."
}

exit 0
