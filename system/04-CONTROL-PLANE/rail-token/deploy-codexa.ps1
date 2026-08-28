<#
.SYNOPSIS
    Propagate ORANGEBOX_RAIL_TOKEN from the N150 to Codexa via SSH/SCP,
    verify the remote sha256, and trigger a remote orangebox-bridge reload.

.DESCRIPTION
    This is the Codexa half of the Codexa rail token rotation doctrine. Its
    sibling 'store-n150.ps1' anchors the token in Windows Credential Manager
    (DPAPI) on the operator machine. This script:

        1. Reads the fresh token from stdin (NEVER a parameter, env, file
           path, or argv). Same intake discipline as store-n150.ps1.
        2. Computes the sha256 fingerprint locally.
        3. Writes the token to a short-lived staging file under
           $env:TEMP with a restrictive ACL.
        4. SCPs that staging file to Codexa at /opt/atomeons/.rail-token
           via an interim path (.rail-token.new) so the move is atomic.
        5. Over SSH:
             - chmod 600 + chown atomeons:atomeons on .rail-token.new
             - sha256sum it and capture the digest
             - atomic mv .rail-token.new -> .rail-token
             - systemctl reload-or-restart orangebox-bridge
             - systemctl is-active orangebox-bridge (post-check)
        6. Compares local sha256 to remote sha256. If they differ, aborts
           and triggers a remote 'rm -f .rail-token.new' cleanup.
        7. Scrubs the local staging file (overwrite + delete) regardless.
        8. Writes a non-secret state file recording prior + new sha256,
           remote host, transport, and the gateway reload status.

    The gateway is expected to file-watch /opt/atomeons/.rail-token and
    re-read on change, so the systemctl reload is belt-and-suspenders.
    If you have NOT yet wired the gateway watcher, the reload is the
    authoritative refresh path.

    Mom's Law:
        - The token never appears in any log line, receipt, env var
          we echo, or stdout JSON. Only sha256 fingerprints.
        - The on-wire transit is SSH (encrypted). The at-rest staging
          file is in $env:TEMP with a current-user-only ACL and is
          best-effort overwritten before deletion.
        - On any failure path that touched a staging file, we
          attempt scrub before exiting.
        - On any failure path that touched a remote .rail-token.new,
          we attempt remote cleanup before exiting.

    Kill-switch:
        - If ORANGEBOX_RAIL_DISABLED=1 (or -KillSwitch is passed), this
          script refuses to deploy. It writes a DISABLED state record
          and exits non-zero. The Codexa-side gateway is expected to
          honor the same env in its own startup gating.

.PARAMETER RemoteHost
    Codexa DNS name or IP. Defaults to 'codexa.atomeons.lan'. Override
    in dev.

.PARAMETER RemoteUser
    SSH user on Codexa. Defaults to 'atomeons'.

.PARAMETER RemotePort
    SSH port on Codexa. Defaults to 22.

.PARAMETER IdentityFile
    Path to the SSH private key on the N150. Defaults to
    "$HOME\.ssh\codexa_rail_id_ed25519". The key must be set up as an
    authorized non-interactive identity on Codexa for $RemoteUser.

.PARAMETER RemotePath
    Final on-Codexa path for the token. Defaults to
    /opt/atomeons/.rail-token. The interim path is the same with a
    '.new' suffix.

.PARAMETER RemoteUnit
    systemd unit to reload after token swap. Defaults to
    'orangebox-bridge'.

.PARAMETER StateFile
    Path to the non-secret state file on N150. Defaults to
    C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\deploy-codexa.state.json.

.PARAMETER Source
    Free-form rotation source tag, e.g. 'manual', 'scheduled-task',
    'rotation-7d'. Defaults to 'manual'.

.PARAMETER SkipReload
    If set, performs the file deploy + sha256 verification but does NOT
    trigger 'systemctl reload-or-restart'. Useful when the gateway
    file-watcher is sufficient and you want a quieter rotation.

.PARAMETER KillSwitch
    If set, refuses to deploy and emits a DISABLED state record.
    Equivalent to ORANGEBOX_RAIL_DISABLED=1.

.EXAMPLE
    'eyJhbGciOi...token-bytes...' | .\deploy-codexa.ps1

.EXAMPLE
    Get-Content -Raw new-token.txt | `
        .\deploy-codexa.ps1 -RemoteHost 10.0.0.42 -Source 'rotation-7d'

.NOTES
    Author:   Atom McCree (AtomEons)
    Receipt:  Wave 2 close - rail token blocker resolution (Codexa half)
    Doctrine: Codexa rail token rotation, 04-CONTROL-PLANE/rail-token
    Sibling:  store-n150.ps1 (N150 DPAPI half)
#>
[CmdletBinding()]
param(
    [string] $RemoteHost   = 'codexa.atomeons.lan',
    [string] $RemoteUser   = 'atomeons',
    [int]    $RemotePort   = 22,
    [string] $IdentityFile = (Join-Path $HOME '.ssh\codexa_rail_id_ed25519'),
    [string] $RemotePath   = '/opt/atomeons/.rail-token',
    [string] $RemoteUnit   = 'orangebox-bridge',
    [string] $StateFile    = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\deploy-codexa.state.json',
    [string] $Source       = 'manual',
    [switch] $SkipReload,
    [switch] $KillSwitch
)

# -----------------------------------------------------------------------------
# Strict mode. Partial state on either side of the wire is the worst outcome
# we can produce, so we fail loudly and clean up on the way out.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Logging helpers. NEVER write the token. Only fingerprints and status.
# Receipts are stable, timestamped, prefixed; designed to be grep-friendly
# and Reality-Flux-ingestible.
# -----------------------------------------------------------------------------
function Write-Receipt {
    param([string] $Message, [string] $Level = 'INFO')
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Write-Host "[$ts] [$Level] deploy-codexa: $Message"
}

# Will be populated as we go. Used by cleanup at any exit point.
$script:LocalStagingPath  = $null
$script:RemoteStagingPath = "$RemotePath.new"
$script:TouchedRemote     = $false

function Invoke-LocalScrub {
    param([string] $Path)
    if ([string]::IsNullOrEmpty($Path)) { return }
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        # Best-effort overwrite of the staging file before deletion.
        $len = (Get-Item -LiteralPath $Path).Length
        if ($len -gt 0) {
            $zero = New-Object byte[] ([Math]::Min($len, 65536))
            $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $remaining = $len
                while ($remaining -gt 0) {
                    $chunk = [Math]::Min($remaining, $zero.Length)
                    $fs.Write($zero, 0, [int]$chunk)
                    $remaining -= $chunk
                }
                $fs.Flush($true)
            } finally {
                $fs.Dispose()
            }
        }
    } catch {
        Write-Receipt "local scrub overwrite failed (continuing to delete): $($_.Exception.Message)" 'WARN'
    }
    try {
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        Write-Receipt "local staging file delete failed: $($_.Exception.Message)" 'WARN'
    }
}

function Invoke-RemoteCleanup {
    param([string] $Reason)
    if (-not $script:TouchedRemote) { return }
    Write-Receipt "remote cleanup triggered ($Reason): rm -f $($script:RemoteStagingPath)" 'WARN'
    try {
        $sshArgs = @(
            '-p', $RemotePort,
            '-i', $IdentityFile,
            '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10',
            "$RemoteUser@$RemoteHost",
            "rm -f -- '$($script:RemoteStagingPath)'"
        )
        & ssh.exe @sshArgs *> $null
    } catch {
        Write-Receipt "remote cleanup ssh failed: $($_.Exception.Message)" 'WARN'
    }
}

# -----------------------------------------------------------------------------
# Resolve state directory; create if missing. Same convention as store-n150.
# -----------------------------------------------------------------------------
$stateDir = Split-Path -Parent $StateFile
if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    Write-Receipt "created state directory: $stateDir"
}

# -----------------------------------------------------------------------------
# Kill-switch path. Refuse to deploy. Emit a disabled state record. We do
# this BEFORE reading stdin so a leaked-token-from-test never even enters
# the process memory of a disabled rotation.
# -----------------------------------------------------------------------------
$envDisabled = $env:ORANGEBOX_RAIL_DISABLED
if ($KillSwitch -or ($envDisabled -eq '1')) {
    $disabledState = [ordered]@{
        schema_version    = 1
        remote_host       = $RemoteHost
        remote_user       = $RemoteUser
        remote_path       = $RemotePath
        remote_unit       = $RemoteUnit
        disabled          = $true
        reason            = if ($KillSwitch) { 'KillSwitch parameter' } else { 'ORANGEBOX_RAIL_DISABLED=1' }
        sha256            = $null
        prior_sha256      = $null
        deployed_at_utc   = (Get-Date).ToUniversalTime().ToString('o')
        rotation_source   = $Source
        host              = $env:COMPUTERNAME
        user              = $env:USERNAME
    }
    $disabledState | ConvertTo-Json -Depth 4 | Out-File -FilePath $StateFile -Encoding utf8 -Force
    Write-Receipt "kill-switch engaged - refusing to deploy to Codexa; state file marked DISABLED" 'WARN'
    exit 2
}

# -----------------------------------------------------------------------------
# Pre-flight: required tools and identity file presence.
# -----------------------------------------------------------------------------
$sshCmd = Get-Command ssh.exe -ErrorAction SilentlyContinue
$scpCmd = Get-Command scp.exe -ErrorAction SilentlyContinue
if ($null -eq $sshCmd -or $null -eq $scpCmd) {
    Write-Receipt "ssh.exe and scp.exe are required (Windows OpenSSH client). Install with 'Add-WindowsCapability'." 'ERROR'
    exit 67
}
if (-not (Test-Path -LiteralPath $IdentityFile)) {
    Write-Receipt "SSH identity file not found: $IdentityFile" 'ERROR'
    exit 68
}

# -----------------------------------------------------------------------------
# Read token from stdin ONLY. Never from a parameter, env, or file path.
# Identical contract to store-n150.ps1.
# -----------------------------------------------------------------------------
if ([Console]::IsInputRedirected -eq $false) {
    Write-Receipt "no stdin detected - token must be piped in. Aborting." 'ERROR'
    Write-Receipt "usage: 'tokenvalue' | .\deploy-codexa.ps1" 'ERROR'
    exit 64
}

$token = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($token)) {
    Write-Receipt "stdin was empty - no token to deploy. Aborting." 'ERROR'
    exit 65
}

# Trim ONLY surrounding whitespace/newlines; token bytes themselves preserved.
$token = $token.Trim()

if ($token.Length -lt 32) {
    Write-Receipt "token shorter than 32 chars - refusing (weak token). Aborting." 'ERROR'
    $token = $null
    [GC]::Collect()
    exit 66
}

# -----------------------------------------------------------------------------
# Compute local sha256 fingerprint over the UTF-8 token bytes. This is the
# value we compare to the remote sha256sum after SCP to detect any transport
# corruption or wrong-file landing.
# -----------------------------------------------------------------------------
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$tokenSha256 = $null
try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha.ComputeHash($tokenBytes)
    $tokenSha256 = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
} finally {
    if ($null -ne $sha) { $sha.Dispose() }
    # Best-effort zero of the byte buffer (managed memory; not bulletproof).
    for ($i = 0; $i -lt $tokenBytes.Length; $i++) { $tokenBytes[$i] = 0 }
}
$tokenShaShort = $tokenSha256.Substring(0, 12)
Write-Receipt "computed local sha256 fingerprint: $tokenShaShort..."

# -----------------------------------------------------------------------------
# Capture prior sha256 from state file if present (for audit / rotation receipt).
# -----------------------------------------------------------------------------
$priorSha256 = $null
if (Test-Path -LiteralPath $StateFile) {
    try {
        $priorState = Get-Content -Raw -LiteralPath $StateFile | ConvertFrom-Json
        if ($priorState.PSObject.Properties.Name -contains 'sha256') {
            $priorSha256 = $priorState.sha256
        }
    } catch {
        Write-Receipt "could not parse prior state file (will overwrite): $($_.Exception.Message)" 'WARN'
    }
}

if ($priorSha256 -and ($priorSha256 -eq $tokenSha256)) {
    Write-Receipt "NEW token sha256 matches prior - no actual rotation occurred. Continuing to ensure Codexa-side file is current." 'WARN'
}

# -----------------------------------------------------------------------------
# Stage the token to a current-user-only file in $env:TEMP. SCP needs a path,
# not a stream, so we touch disk briefly; we lock the ACL down and scrub on
# exit (success or failure).
# -----------------------------------------------------------------------------
$stagingName = "ae-rail-stage-$([Guid]::NewGuid().ToString('N')).tok"
$script:LocalStagingPath = Join-Path $env:TEMP $stagingName

try {
    # Write LF-only, no BOM. Codexa's gateway expects bare bytes.
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($script:LocalStagingPath, $token, $utf8NoBom)
} catch {
    Write-Receipt "failed to write local staging file: $($_.Exception.Message)" 'ERROR'
    $token = $null
    [GC]::Collect()
    exit 71
}

# Drop our last managed reference to the raw token; the bytes still live on
# disk in the staging file (which we scrub on exit) and in Codexa's
# .rail-token (which is the whole point).
$token = $null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

# Tighten ACL on the staging file to current user only.
try {
    $stageAcl = Get-Acl -LiteralPath $script:LocalStagingPath
    $stageAcl.SetAccessRuleProtection($true, $false)
    $stageRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "$env:USERDOMAIN\$env:USERNAME",
        'FullControl',
        'Allow'
    )
    $stageAcl.SetAccessRule($stageRule)
    Set-Acl -LiteralPath $script:LocalStagingPath -AclObject $stageAcl
} catch {
    Write-Receipt "could not tighten staging ACL (continuing): $($_.Exception.Message)" 'WARN'
}

# -----------------------------------------------------------------------------
# SCP the staging file to Codexa's interim path (.rail-token.new). We never
# write directly to the final .rail-token path; the swap is an atomic mv on
# the remote side, so the gateway never reads a half-flushed file.
# -----------------------------------------------------------------------------
$remoteSpec = "${RemoteUser}@${RemoteHost}:$($script:RemoteStagingPath)"

$scpArgs = @(
    '-P', $RemotePort,
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    '-q',
    $script:LocalStagingPath,
    $remoteSpec
)

Write-Receipt "scp -> ${RemoteUser}@${RemoteHost}:$($script:RemoteStagingPath) (port=$RemotePort)"

$scpOut = $null
$scpErr = $null
try {
    $scpStdout = [System.IO.Path]::GetTempFileName()
    $scpStderr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'scp.exe' `
        -ArgumentList $scpArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $scpStdout `
        -RedirectStandardError  $scpStderr
    $scpOut = Get-Content -Raw -LiteralPath $scpStdout -ErrorAction SilentlyContinue
    $scpErr = Get-Content -Raw -LiteralPath $scpStderr -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $scpStdout, $scpStderr -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Write-Receipt "scp.exe exited with code $($proc.ExitCode). stderr: $scpErr" 'ERROR'
        Invoke-LocalScrub -Path $script:LocalStagingPath
        exit 72
    }
} catch {
    Write-Receipt "scp invocation failed: $($_.Exception.Message)" 'ERROR'
    Invoke-LocalScrub -Path $script:LocalStagingPath
    exit 72
}

# From this point forward, a .new file exists on Codexa. Track it so any
# failure path can clean up.
$script:TouchedRemote = $true
Write-Receipt "scp ok - staged at remote interim path"

# -----------------------------------------------------------------------------
# Over SSH: chmod/chown, sha256sum, compare, atomic mv, reload, status.
# We issue a single ssh invocation with a here-doc-style chained command so
# the remote side either fully succeeds or we get one exit code to react to.
# The remote script echoes ONLY the sha256 line and a status tag; nothing
# leaks the token.
# -----------------------------------------------------------------------------
$remoteScript = @"
set -eu
umask 077
chmod 600 '$($script:RemoteStagingPath)'
chown $RemoteUser`:$RemoteUser '$($script:RemoteStagingPath)' 2>/dev/null || true
REMOTE_SHA=`$(sha256sum '$($script:RemoteStagingPath)' | awk '{print `$1}')
echo "REMOTE_SHA256=`$REMOTE_SHA"
"@

$sshArgsVerify = @(
    '-p', $RemotePort,
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    "$RemoteUser@$RemoteHost",
    $remoteScript
)

$remoteSha = $null
try {
    $sshStdout = [System.IO.Path]::GetTempFileName()
    $sshStderr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'ssh.exe' `
        -ArgumentList $sshArgsVerify `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $sshStdout `
        -RedirectStandardError  $sshStderr
    $sshOut = Get-Content -Raw -LiteralPath $sshStdout -ErrorAction SilentlyContinue
    $sshErr = Get-Content -Raw -LiteralPath $sshStderr -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sshStdout, $sshStderr -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Write-Receipt "remote verify step failed (exit=$($proc.ExitCode)). stderr: $sshErr" 'ERROR'
        Invoke-RemoteCleanup -Reason 'verify-failed'
        Invoke-LocalScrub -Path $script:LocalStagingPath
        exit 73
    }
    if ($sshOut -match 'REMOTE_SHA256=([0-9a-f]{64})') {
        $remoteSha = $Matches[1].ToLowerInvariant()
    } else {
        Write-Receipt "remote did not return a parseable sha256 line. stdout: $sshOut" 'ERROR'
        Invoke-RemoteCleanup -Reason 'no-remote-sha'
        Invoke-LocalScrub -Path $script:LocalStagingPath
        exit 74
    }
} catch {
    Write-Receipt "ssh verify invocation failed: $($_.Exception.Message)" 'ERROR'
    Invoke-RemoteCleanup -Reason 'ssh-throw'
    Invoke-LocalScrub -Path $script:LocalStagingPath
    exit 73
}

Write-Receipt "remote sha256: $($remoteSha.Substring(0,12))..."

if ($remoteSha -ne $tokenSha256) {
    Write-Receipt "SHA256 MISMATCH local=$tokenShaShort remote=$($remoteSha.Substring(0,12)) - aborting promotion" 'ERROR'
    Invoke-RemoteCleanup -Reason 'sha-mismatch'
    Invoke-LocalScrub -Path $script:LocalStagingPath
    exit 75
}

Write-Receipt "sha256 verified end-to-end"

# -----------------------------------------------------------------------------
# Promote: atomic mv .rail-token.new -> .rail-token, then reload service.
# We split this from verify so a sha mismatch never leaves the gateway
# pointed at a poisoned file.
# -----------------------------------------------------------------------------
$reloadFragment = if ($SkipReload) {
    "echo 'RELOAD=skipped'"
} else {
    # reload-or-restart: prefer SIGHUP-style reload if the unit supports it,
    # else full restart. is-active is the post-check.
    @"
if sudo -n systemctl reload-or-restart '$RemoteUnit' 2>/tmp/.ae-reload.err; then
  echo 'RELOAD=ok'
else
  echo 'RELOAD=fail'
  cat /tmp/.ae-reload.err >&2 || true
  exit 80
fi
sleep 1
if sudo -n systemctl is-active --quiet '$RemoteUnit'; then
  echo 'UNIT=active'
else
  echo 'UNIT=inactive'
  exit 81
fi
"@
}

$promoteScript = @"
set -eu
mv -f '$($script:RemoteStagingPath)' '$RemotePath'
chmod 600 '$RemotePath'
chown $RemoteUser`:$RemoteUser '$RemotePath' 2>/dev/null || true
echo 'PROMOTE=ok'
$reloadFragment
"@

$sshArgsPromote = @(
    '-p', $RemotePort,
    '-i', $IdentityFile,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=10',
    "$RemoteUser@$RemoteHost",
    $promoteScript
)

$reloadStatus = if ($SkipReload) { 'skipped' } else { 'unknown' }
$unitStatus   = if ($SkipReload) { 'unchecked' } else { 'unknown' }

try {
    $sshStdout = [System.IO.Path]::GetTempFileName()
    $sshStderr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'ssh.exe' `
        -ArgumentList $sshArgsPromote `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $sshStdout `
        -RedirectStandardError  $sshStderr
    $sshOut = Get-Content -Raw -LiteralPath $sshStdout -ErrorAction SilentlyContinue
    $sshErr = Get-Content -Raw -LiteralPath $sshStderr -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $sshStdout, $sshStderr -Force -ErrorAction SilentlyContinue

    if ($proc.ExitCode -ne 0) {
        Write-Receipt "remote promote/reload failed (exit=$($proc.ExitCode)). stderr: $sshErr" 'ERROR'
        # At this point .new may or may not have been moved. We can't safely
        # rollback to a prior token from N150-side here (we don't keep it).
        # Best we can do: leave audit trail and refuse to declare success.
        Invoke-LocalScrub -Path $script:LocalStagingPath
        exit 76
    }

    if ($sshOut -notmatch 'PROMOTE=ok') {
        Write-Receipt "remote did not confirm PROMOTE=ok. stdout: $sshOut" 'ERROR'
        Invoke-LocalScrub -Path $script:LocalStagingPath
        exit 77
    }
    # Once PROMOTE=ok lands, the staging path is gone; clear the cleanup flag.
    $script:TouchedRemote = $false

    if (-not $SkipReload) {
        if     ($sshOut -match 'RELOAD=ok')   { $reloadStatus = 'ok' }
        elseif ($sshOut -match 'RELOAD=fail') { $reloadStatus = 'fail' }
        if     ($sshOut -match 'UNIT=active')   { $unitStatus = 'active' }
        elseif ($sshOut -match 'UNIT=inactive') { $unitStatus = 'inactive' }
        Write-Receipt "remote reload=$reloadStatus unit=$unitStatus"
    } else {
        Write-Receipt "reload skipped per -SkipReload flag (gateway file-watcher is expected to pick up the change)"
    }
} catch {
    Write-Receipt "ssh promote invocation failed: $($_.Exception.Message)" 'ERROR'
    Invoke-LocalScrub -Path $script:LocalStagingPath
    exit 76
}

# -----------------------------------------------------------------------------
# Scrub local staging artifact. Success path.
# -----------------------------------------------------------------------------
Invoke-LocalScrub -Path $script:LocalStagingPath
$script:LocalStagingPath = $null

# -----------------------------------------------------------------------------
# Write the non-secret state file. Contains ONLY:
#   - new sha256 fingerprint
#   - prior sha256 fingerprint (for audit chain)
#   - remote host / user / path / unit / transport
#   - reload + unit status
# NEVER contains the token itself.
# -----------------------------------------------------------------------------
$state = [ordered]@{
    schema_version    = 1
    remote_host       = $RemoteHost
    remote_user       = $RemoteUser
    remote_port       = $RemotePort
    remote_path       = $RemotePath
    remote_unit       = $RemoteUnit
    transport         = 'scp+ssh (Windows OpenSSH)'
    disabled          = $false
    sha256            = $tokenSha256
    sha256_short      = $tokenShaShort
    prior_sha256      = $priorSha256
    deployed_at_utc   = (Get-Date).ToUniversalTime().ToString('o')
    rotation_source   = $Source
    reload_status     = $reloadStatus
    unit_status       = $unitStatus
    skip_reload       = [bool]$SkipReload
    host              = $env:COMPUTERNAME
    user              = $env:USERNAME
    note              = 'Non-secret state file. Contains sha256 fingerprint only; never the token.'
}

$state | ConvertTo-Json -Depth 4 | Out-File -FilePath $StateFile -Encoding utf8 -Force

# Lock down the state file ACL to the current user.
try {
    $acl = Get-Acl -LiteralPath $StateFile
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "$env:USERDOMAIN\$env:USERNAME",
        'FullControl',
        'Allow'
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $StateFile -AclObject $acl
} catch {
    Write-Receipt "could not tighten state file ACL: $($_.Exception.Message)" 'WARN'
}

Write-Receipt "state file written: $StateFile"
Write-Receipt "rotation receipt: prior_sha=$(if ($priorSha256) { $priorSha256.Substring(0,12) + '...' } else { '<none>' }) new_sha=$tokenShaShort... source=$Source reload=$reloadStatus unit=$unitStatus"
Write-Receipt "OK - rail token deployed to ${RemoteUser}@${RemoteHost}:$RemotePath"

# Emit machine-readable summary on stdout for callers that pipe.
[pscustomobject]@{
    ok                = $true
    remote_host       = $RemoteHost
    remote_user       = $RemoteUser
    remote_path       = $RemotePath
    remote_unit       = $RemoteUnit
    sha256            = $tokenSha256
    sha256_short      = $tokenShaShort
    prior_sha256      = $priorSha256
    deployed_at_utc   = $state.deployed_at_utc
    rotation_source   = $Source
    reload_status     = $reloadStatus
    unit_status       = $unitStatus
    skip_reload       = [bool]$SkipReload
    state_file        = $StateFile
} | ConvertTo-Json -Depth 3

exit 0
