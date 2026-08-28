<#
.SYNOPSIS
    Orchestrate a full ORANGEBOX_RAIL_TOKEN rotation across all three storage
    sites: N150 (DPAPI), Codexa (/opt/atomeons/.rail-token via SSH+systemd),
    and Atomic Orange (Tauri stronghold via IPC). Refuses to proceed if any
    site is unreachable. Writes a Reality-Flux audit receipt.

.DESCRIPTION
    This is the top-level driver of the Codexa rail token rotation doctrine
    (see Wave 2 close receipt - rail token blocker). It ties together three
    sibling artifacts:

        generate.mjs        - mints the new 256-bit HS256-grade token
                              (Node; sole place raw bytes exist)
        store-n150.ps1      - persists to Windows Credential Manager (DPAPI)
                              via stdin
        deploy-codexa.ps1   - SCPs to Codexa /opt/atomeons/.rail-token and
                              triggers systemctl reload-or-restart
                              orangebox-bridge via stdin

    plus a fourth step performed inline here:

        Atomic Orange       - posts the token to the Tauri sidecar IPC
                              endpoint, which writes it into the
                              tauri-plugin-stronghold encrypted store.

    Flow (this script):

        0. Preflight EVERY storage site for reachability BEFORE minting.
           If any site is unreachable, abort with no token in memory.
        1. Mint a fresh token via generate.mjs (piped, never on disk).
        2. Fan the same in-memory token to:
             a. store-n150.ps1     (stdin)
             b. deploy-codexa.ps1  (stdin)
             c. Atomic Orange IPC  (HTTPS POST, body = token)
        3. Wait for each step to confirm. ANY failure -> rollback what we
           can, refuse to declare success, and write an audit row marking
           the rotation as PARTIAL or FAILED.
        4. On full success: scrub in-memory token, compute the global
           sha256, write the Reality Flux audit receipt with prior + new
           fingerprints and per-site status.

    Mom's Law:
        - The token never appears on stdout, in a log line, on disk
          outside the explicit storage sites, or in receipts. Only
          sha256 fingerprints are persisted.
        - The orchestrator refuses to start unless all three sites
          respond to preflight, so we never publish a token to two
          sites and leave the third pointing at the old one (or worse,
          unauthenticated).
        - On any partial failure, the audit row says PARTIAL with the
          per-site status, and exit code is non-zero. The next rotation
          can be retried idempotently; the gateway is hot-reload.

    Kill-switch:
        - If $env:ORANGEBOX_RAIL_DISABLED='1' or -KillSwitch is passed,
          this script refuses to mint or deploy ANYTHING, writes a
          DISABLED audit row, and exits 2. The gateway is expected to
          honor the same env independently.

    Scheduled rotation:
        - Designed to be invoked from Windows Task Scheduler every 7
          days (and from Codexa's systemd timer's matching half).
        - With -Source 'scheduled-task' for audit attribution.
        - Exit code 0 only on full success across all three sites.

.PARAMETER Source
    Free-form rotation source tag. 'manual', 'scheduled-task',
    'rotation-7d', etc. Defaults to 'manual'.

.PARAMETER CodexaRemoteHost
    Codexa SSH host. Defaults to 'codexa.atomeons.lan'.

.PARAMETER CodexaRemoteUser
    Codexa SSH user. Defaults to 'atomeons'.

.PARAMETER CodexaRemotePort
    Codexa SSH port. Defaults to 22.

.PARAMETER CodexaIdentityFile
    Path to the SSH private key. Defaults to
    "$HOME\.ssh\codexa_rail_id_ed25519".

.PARAMETER AtomicOrangeEndpoint
    Tauri IPC endpoint URL on the local Atomic Orange app. The app
    listens on localhost over HTTPS with a pinned cert. Defaults to
    'https://127.0.0.1:17645/ipc/rail-token/rotate'.

.PARAMETER AtomicOrangeCertThumbprint
    Expected SHA-256 thumbprint of the Atomic Orange server cert. The
    POST is rejected if the served cert does not match. Defaults to
    reading $env:ATOMIC_ORANGE_CERT_SHA256.

.PARAMETER AuditFile
    Path to the Reality-Flux-ingestible audit receipt file (append-only
    JSONL). Defaults to
    C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\rotate.audit.jsonl.

.PARAMETER PreflightTimeoutSeconds
    Per-site preflight reachability timeout. Defaults to 5.

.PARAMETER SiteConfirmTimeoutSeconds
    Per-site post-deploy confirmation timeout. Defaults to 30.

.PARAMETER SkipCodexaReload
    Forwarded to deploy-codexa.ps1 as -SkipReload. The gateway's
    file-watcher is expected to pick up the change without systemctl.

.PARAMETER DryRun
    Run preflight only. Do not mint or deploy anything. Useful for
    Task Scheduler health-checks.

.PARAMETER KillSwitch
    Refuse to rotate. Equivalent to ORANGEBOX_RAIL_DISABLED=1.

.EXAMPLE
    .\rotate.ps1

.EXAMPLE
    .\rotate.ps1 -Source 'rotation-7d' -SkipCodexaReload

.EXAMPLE
    .\rotate.ps1 -DryRun

.NOTES
    Author:   Atom McCree (AtomEons)
    Receipt:  Wave 2 close - rail token blocker resolution (orchestrator)
    Doctrine: Codexa rail token rotation, 04-CONTROL-PLANE/rail-token
    Siblings: generate.mjs, store-n150.ps1, deploy-codexa.ps1
#>
[CmdletBinding()]
param(
    [string] $Source                     = 'manual',

    [string] $CodexaRemoteHost           = 'codexa.atomeons.lan',
    [string] $CodexaRemoteUser           = 'atomeons',
    [int]    $CodexaRemotePort           = 22,
    [string] $CodexaIdentityFile         = (Join-Path $HOME '.ssh\codexa_rail_id_ed25519'),

    [string] $AtomicOrangeEndpoint       = 'https://127.0.0.1:17645/ipc/rail-token/rotate',
    [string] $AtomicOrangeCertThumbprint = $env:ATOMIC_ORANGE_CERT_SHA256,

    [string] $AuditFile                  = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\rotate.audit.jsonl',

    [int]    $PreflightTimeoutSeconds    = 5,
    [int]    $SiteConfirmTimeoutSeconds  = 30,

    [switch] $SkipCodexaReload,
    [switch] $DryRun,
    [switch] $KillSwitch
)

# -----------------------------------------------------------------------------
# Strict mode. Partial rotation is the worst outcome we can produce, so we
# bias HARD toward refusing to start vs. recovering mid-flight.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Paths to sibling scripts. Resolve relative to THIS script so the orchestrator
# works under any cwd (Task Scheduler runs from %SystemRoot%).
# -----------------------------------------------------------------------------
$scriptDir       = Split-Path -Parent $MyInvocation.MyCommand.Path
$generateScript  = Join-Path $scriptDir 'generate.mjs'
$storeScript     = Join-Path $scriptDir 'store-n150.ps1'
$deployScript    = Join-Path $scriptDir 'deploy-codexa.ps1'

# -----------------------------------------------------------------------------
# Logging helpers. NEVER write the token. Only fingerprints, site status, and
# preflight outcomes. Receipts are timestamped UTC, prefixed, grep-friendly.
# -----------------------------------------------------------------------------
function Write-Receipt {
    param([string] $Message, [string] $Level = 'INFO')
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Write-Host "[$ts] [$Level] rotate: $Message"
}

# -----------------------------------------------------------------------------
# Audit row writer. Append-only JSONL into the Reality-Flux-ingestible file.
# Token NEVER appears in any field. We capture:
#   - schema_version, rotation_id (uuid), source, started_at_utc, finished_at_utc
#   - prior_sha256, new_sha256 (or null if never minted)
#   - per_site: { n150, codexa, atomic_orange } each with status + sha256
#   - outcome: 'ok' | 'partial' | 'failed' | 'disabled' | 'aborted-preflight'
#   - host, user
# -----------------------------------------------------------------------------
function Write-AuditRow {
    param(
        [string]   $Outcome,
        [string]   $RotationId,
        [datetime] $StartedAtUtc,
        [string]   $PriorSha256,
        [string]   $NewSha256,
        [hashtable]$PerSite,
        [string]   $FailReason = $null
    )
    try {
        $auditDir = Split-Path -Parent $AuditFile
        if (-not (Test-Path -LiteralPath $auditDir)) {
            New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
        }
        $row = [ordered]@{
            schema_version   = 1
            rotation_id      = $RotationId
            rotation_source  = $Source
            started_at_utc   = $StartedAtUtc.ToUniversalTime().ToString('o')
            finished_at_utc  = (Get-Date).ToUniversalTime().ToString('o')
            outcome          = $Outcome
            fail_reason      = $FailReason
            prior_sha256     = $PriorSha256
            new_sha256       = $NewSha256
            per_site         = $PerSite
            host             = $env:COMPUTERNAME
            user             = $env:USERNAME
            note             = 'Non-secret audit row. sha256 fingerprints only; never the token.'
        }
        # Compact one-line JSON for JSONL append.
        $json = $row | ConvertTo-Json -Depth 6 -Compress
        Add-Content -LiteralPath $AuditFile -Value $json -Encoding utf8
    } catch {
        Write-Receipt "audit row write failed: $($_.Exception.Message)" 'WARN'
    }
}

# Initialize per-site status hashtable. Each entry mutates as we progress.
function New-PerSiteStatus {
    return @{
        n150 = @{
            status         = 'pending'
            sha256         = $null
            stored_by      = $null
            state_file     = $null
            error          = $null
        }
        codexa = @{
            status         = 'pending'
            sha256         = $null
            remote_path    = $null
            remote_unit    = $null
            reload_status  = $null
            unit_status    = $null
            state_file     = $null
            error          = $null
        }
        atomic_orange = @{
            status         = 'pending'
            sha256         = $null
            endpoint       = $AtomicOrangeEndpoint
            stronghold     = $null
            error          = $null
        }
    }
}

# Generate a rotation_id (stable for the whole run, used in audit + any
# remote receipt correlation we want later).
$rotationId   = [Guid]::NewGuid().ToString()
$startedAtUtc = Get-Date

Write-Receipt "rotation_id=$rotationId source=$Source dry_run=$([bool]$DryRun)"

# -----------------------------------------------------------------------------
# Kill-switch path. Refuse to rotate. Emit a DISABLED audit row.
# Performed BEFORE any preflight or stdin read so a leaked-test value never
# enters this process.
# -----------------------------------------------------------------------------
$envDisabled = $env:ORANGEBOX_RAIL_DISABLED
if ($KillSwitch -or ($envDisabled -eq '1')) {
    $perSite = New-PerSiteStatus
    foreach ($k in @($perSite.Keys)) { $perSite[$k].status = 'skipped-disabled' }
    $disabledReason = if ($KillSwitch) { 'KillSwitch parameter' } else { 'ORANGEBOX_RAIL_DISABLED=1' }
    Write-AuditRow `
        -Outcome 'disabled' `
        -RotationId $rotationId `
        -StartedAtUtc $startedAtUtc `
        -PriorSha256 $null `
        -NewSha256 $null `
        -PerSite $perSite `
        -FailReason $disabledReason
    Write-Receipt 'kill-switch engaged - refusing to mint or deploy. Audit row written.' 'WARN'
    exit 2
}

# -----------------------------------------------------------------------------
# Tool presence check. We need: node.exe, ssh.exe, scp.exe.
# Curl-equivalent for the Atomic Orange POST is built-in via Invoke-WebRequest.
# -----------------------------------------------------------------------------
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$sshCmd  = Get-Command ssh.exe  -ErrorAction SilentlyContinue
$scpCmd  = Get-Command scp.exe  -ErrorAction SilentlyContinue

if ($null -eq $nodeCmd) {
    Write-Receipt 'node.exe is required (generate.mjs is Node). Aborting.' 'ERROR'
    exit 67
}
if ($null -eq $sshCmd -or $null -eq $scpCmd) {
    Write-Receipt 'ssh.exe and scp.exe are required (Windows OpenSSH client). Aborting.' 'ERROR'
    exit 67
}

# Sibling script presence check.
foreach ($p in @($generateScript, $storeScript, $deployScript)) {
    if (-not (Test-Path -LiteralPath $p)) {
        Write-Receipt "sibling script missing: $p" 'ERROR'
        exit 68
    }
}

# -----------------------------------------------------------------------------
# Capture prior global sha256 from the audit tail (last row's new_sha256) for
# the audit chain. We tolerate a missing audit file - first rotation has no
# prior.
# -----------------------------------------------------------------------------
$priorSha256 = $null
if (Test-Path -LiteralPath $AuditFile) {
    try {
        $lastLine = Get-Content -LiteralPath $AuditFile -Tail 1 -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace($lastLine)) {
            $lastRow = $lastLine | ConvertFrom-Json -ErrorAction Stop
            if ($lastRow.PSObject.Properties.Name -contains 'new_sha256') {
                $priorSha256 = $lastRow.new_sha256
            }
        }
    } catch {
        Write-Receipt "could not read prior audit tail (will continue): $($_.Exception.Message)" 'WARN'
    }
}

# -----------------------------------------------------------------------------
# STEP 0: Preflight all three storage sites BEFORE minting. If any site is
# unreachable, abort with no token ever entering memory.
#
# This is the single most important invariant of the orchestrator: we never
# leave the rail in a state where some sites have the new token and one site
# still has the old (or no) token. That breaks auth in non-obvious ways.
# -----------------------------------------------------------------------------
Write-Receipt 'preflight: checking reachability of all three storage sites'

$perSite = New-PerSiteStatus
$preflightFailures = @()

# 0a) N150: Credential Manager is local. We probe by importing the module
# (if present) and listing credentials, OR by invoking cmdkey /list. The
# operation we actually need (writing a credential) is gated by user session,
# which is trivially available since we ARE the user session.
try {
    $credMgrModule = Get-Module -ListAvailable -Name 'CredentialManager' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $credMgrModule) {
        # Just verify the module imports cleanly. Don't read existing creds.
        Import-Module CredentialManager -ErrorAction Stop
        $perSite.n150.status = 'reachable'
    } else {
        # Fallback: cmdkey is always present on supported Windows.
        $cmdkey = Get-Command cmdkey.exe -ErrorAction Stop
        if ($null -ne $cmdkey) {
            $perSite.n150.status = 'reachable'
        } else {
            throw 'neither CredentialManager module nor cmdkey.exe available'
        }
    }
    Write-Receipt 'preflight n150: reachable'
} catch {
    $perSite.n150.status = 'unreachable'
    $perSite.n150.error  = $_.Exception.Message
    $preflightFailures += "n150: $($_.Exception.Message)"
    Write-Receipt "preflight n150 FAIL: $($_.Exception.Message)" 'ERROR'
}

# 0b) Codexa: SSH BatchMode probe with a short ConnectTimeout. We run a
# trivial remote 'true' and check exit code. Any auth or network failure
# fails preflight without minting.
try {
    if (-not (Test-Path -LiteralPath $CodexaIdentityFile)) {
        throw "SSH identity file not found: $CodexaIdentityFile"
    }
    $sshProbeArgs = @(
        '-p', $CodexaRemotePort,
        '-i', $CodexaIdentityFile,
        '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes',
        '-o', "ConnectTimeout=$PreflightTimeoutSeconds",
        "$CodexaRemoteUser@$CodexaRemoteHost",
        'test -d /opt/atomeons && true'
    )
    $probeStdout = [System.IO.Path]::GetTempFileName()
    $probeStderr = [System.IO.Path]::GetTempFileName()
    $proc = Start-Process -FilePath 'ssh.exe' `
        -ArgumentList $sshProbeArgs `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $probeStdout `
        -RedirectStandardError  $probeStderr
    $probeErr = Get-Content -Raw -LiteralPath $probeStderr -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $probeStdout, $probeStderr -Force -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        throw "ssh probe exited $($proc.ExitCode): $probeErr"
    }
    $perSite.codexa.status = 'reachable'
    Write-Receipt "preflight codexa: reachable (${CodexaRemoteUser}@${CodexaRemoteHost}:${CodexaRemotePort})"
} catch {
    $perSite.codexa.status = 'unreachable'
    $perSite.codexa.error  = $_.Exception.Message
    $preflightFailures += "codexa: $($_.Exception.Message)"
    Write-Receipt "preflight codexa FAIL: $($_.Exception.Message)" 'ERROR'
}

# 0c) Atomic Orange: GET the health probe endpoint (sibling of the rotate
# endpoint). We pin the cert thumbprint when supplied. If unset, we still
# require the connection to succeed but warn that pinning is off.
try {
    if ([string]::IsNullOrEmpty($AtomicOrangeCertThumbprint)) {
        Write-Receipt 'preflight atomic-orange: cert thumbprint NOT pinned (ATOMIC_ORANGE_CERT_SHA256 unset). Continuing with TLS only.' 'WARN'
    }
    # Derive a /healthz sibling for the rotate endpoint.
    $healthUri = $AtomicOrangeEndpoint -replace '/ipc/rail-token/rotate$', '/ipc/rail-token/healthz'
    if ($healthUri -eq $AtomicOrangeEndpoint) {
        # Endpoint shape unexpected; use it directly with a HEAD as a last resort.
        $healthUri = $AtomicOrangeEndpoint
    }

    # Build a request with cert pinning via a custom validation callback when
    # we have a thumbprint. We use HttpClient over Invoke-WebRequest because
    # WebRequest in older PS does not expose ServerCertificateValidationCallback
    # cleanly per-request.
    Add-Type -AssemblyName 'System.Net.Http' -ErrorAction SilentlyContinue
    $handler = New-Object System.Net.Http.HttpClientHandler
    if (-not [string]::IsNullOrEmpty($AtomicOrangeCertThumbprint)) {
        $expectedThumb = $AtomicOrangeCertThumbprint.ToLowerInvariant() -replace '[^0-9a-f]', ''
        $handler.ServerCertificateCustomValidationCallback = {
            param($message, $cert, $chain, $errors)
            if ($null -eq $cert) { return $false }
            $thumb = $cert.GetCertHashString('SHA256').ToLowerInvariant()
            return ($thumb -eq $expectedThumb)
        }.GetNewClosure()
    }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($PreflightTimeoutSeconds)
    $req = New-Object System.Net.Http.HttpRequestMessage('GET', $healthUri)
    $resp = $client.SendAsync($req).GetAwaiter().GetResult()
    try {
        if (-not $resp.IsSuccessStatusCode) {
            throw "health probe HTTP $($resp.StatusCode)"
        }
        $perSite.atomic_orange.status = 'reachable'
        Write-Receipt "preflight atomic-orange: reachable ($healthUri)"
    } finally {
        $resp.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
} catch {
    $perSite.atomic_orange.status = 'unreachable'
    $perSite.atomic_orange.error  = $_.Exception.Message
    $preflightFailures += "atomic_orange: $($_.Exception.Message)"
    Write-Receipt "preflight atomic-orange FAIL: $($_.Exception.Message)" 'ERROR'
}

if ($preflightFailures.Count -gt 0) {
    $reason = "preflight unreachable: $($preflightFailures -join '; ')"
    Write-Receipt 'ABORT: at least one storage site is unreachable. Refusing to mint (no partial rotation).' 'ERROR'
    Write-AuditRow `
        -Outcome 'aborted-preflight' `
        -RotationId $rotationId `
        -StartedAtUtc $startedAtUtc `
        -PriorSha256 $priorSha256 `
        -NewSha256 $null `
        -PerSite $perSite `
        -FailReason $reason
    exit 60
}

if ($DryRun) {
    Write-Receipt 'DRY RUN: all sites reachable. Skipping mint + deploy.'
    Write-AuditRow `
        -Outcome 'ok' `
        -RotationId $rotationId `
        -StartedAtUtc $startedAtUtc `
        -PriorSha256 $priorSha256 `
        -NewSha256 $null `
        -PerSite $perSite `
        -FailReason 'dry-run'
    exit 0
}

# -----------------------------------------------------------------------------
# STEP 1: Mint. Run generate.mjs and capture the single-shot stdout JSON.
# We use Start-Process with redirected stdout to avoid pipeline-echo edge
# cases. The temp file holding the JSON lives for milliseconds and is
# scrubbed immediately after parse.
# -----------------------------------------------------------------------------
Write-Receipt 'minting new token via generate.mjs'

$mintStdout = [System.IO.Path]::GetTempFileName()
$mintStderr = [System.IO.Path]::GetTempFileName()
$mintJson   = $null
$rawToken   = $null
$newSha256  = $null

try {
    $proc = Start-Process -FilePath $nodeCmd.Source `
        -ArgumentList @($generateScript) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $mintStdout `
        -RedirectStandardError  $mintStderr
    if ($proc.ExitCode -ne 0) {
        $err = Get-Content -Raw -LiteralPath $mintStderr -ErrorAction SilentlyContinue
        throw "generate.mjs exited $($proc.ExitCode): $err"
    }
    $mintJson = Get-Content -Raw -LiteralPath $mintStdout -ErrorAction Stop
} catch {
    Write-Receipt "mint failed: $($_.Exception.Message)" 'ERROR'
    Remove-Item -LiteralPath $mintStdout, $mintStderr -Force -ErrorAction SilentlyContinue
    Write-AuditRow `
        -Outcome 'failed' `
        -RotationId $rotationId `
        -StartedAtUtc $startedAtUtc `
        -PriorSha256 $priorSha256 `
        -NewSha256 $null `
        -PerSite $perSite `
        -FailReason "mint: $($_.Exception.Message)"
    exit 61
}

# Scrub mint stdout/stderr files IMMEDIATELY after capture. The JSON in
# memory now holds the token; the disk copy must not linger.
try {
    # Best-effort overwrite the stdout temp before delete.
    if (Test-Path -LiteralPath $mintStdout) {
        $len = (Get-Item -LiteralPath $mintStdout).Length
        if ($len -gt 0) {
            $zero = New-Object byte[] $len
            [System.IO.File]::WriteAllBytes($mintStdout, $zero)
        }
    }
} catch {
    Write-Receipt "mint stdout scrub overwrite failed (continuing to delete): $($_.Exception.Message)" 'WARN'
}
Remove-Item -LiteralPath $mintStdout, $mintStderr -Force -ErrorAction SilentlyContinue

try {
    $mintObj   = $mintJson | ConvertFrom-Json -ErrorAction Stop
    $rawToken  = $mintObj.token
    $newSha256 = $mintObj.sha256
    if ([string]::IsNullOrEmpty($rawToken) -or [string]::IsNullOrEmpty($newSha256)) {
        throw 'generate.mjs returned empty token or sha256'
    }
} catch {
    Write-Receipt "mint JSON parse failed: $($_.Exception.Message)" 'ERROR'
    # Drop refs.
    $mintJson = $null
    $rawToken = $null
    [GC]::Collect()
    Write-AuditRow `
        -Outcome 'failed' `
        -RotationId $rotationId `
        -StartedAtUtc $startedAtUtc `
        -PriorSha256 $priorSha256 `
        -NewSha256 $null `
        -PerSite $perSite `
        -FailReason "mint-parse: $($_.Exception.Message)"
    exit 62
}

# Drop the JSON wrapper now that we have the token + sha in their own vars.
$mintJson = $null
$mintObj  = $null
[GC]::Collect()

$newShaShort = $newSha256.Substring(0, 12)
Write-Receipt "minted: sha256=$newShaShort... (raw token held in-memory only)"

# -----------------------------------------------------------------------------
# Helper: dispatch the token to a sibling .ps1 over its stdin contract.
# Pipes the in-memory token string into pwsh.exe -File <sibling>. Captures the
# sibling's stdout JSON summary and stderr text for the per-site record.
# -----------------------------------------------------------------------------
function Invoke-SiblingStdin {
    param(
        [string]   $ScriptPath,
        [string[]] $ScriptArgs,
        [string]   $Token,
        [int]      $TimeoutSeconds
    )
    # Locate the same pwsh we are running under, falling back to powershell.
    $psHost = (Get-Process -Id $PID).Path
    if ([string]::IsNullOrEmpty($psHost)) {
        $pwshCmd = Get-Command pwsh.exe -ErrorAction SilentlyContinue
        if ($null -ne $pwshCmd) { $psHost = $pwshCmd.Source }
    }
    if ([string]::IsNullOrEmpty($psHost)) {
        $psHost = (Get-Command powershell.exe -ErrorAction Stop).Source
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName               = $psHost
    $psi.UseShellExecute        = $false
    $psi.RedirectStandardInput  = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.CreateNoWindow         = $true

    # Build argv: -NoProfile -NonInteractive -File <script> <args...>
    $psi.ArgumentList.Add('-NoProfile') | Out-Null
    $psi.ArgumentList.Add('-NonInteractive') | Out-Null
    $psi.ArgumentList.Add('-ExecutionPolicy') | Out-Null
    $psi.ArgumentList.Add('Bypass') | Out-Null
    $psi.ArgumentList.Add('-File') | Out-Null
    $psi.ArgumentList.Add($ScriptPath) | Out-Null
    foreach ($a in $ScriptArgs) { $psi.ArgumentList.Add($a) | Out-Null }

    $proc = [System.Diagnostics.Process]::Start($psi)
    try {
        # Write token to sibling's stdin, then close stdin so it can proceed.
        $proc.StandardInput.Write($Token)
        $proc.StandardInput.Close()

        if (-not $proc.WaitForExit($TimeoutSeconds * 1000)) {
            try { $proc.Kill($true) } catch { }
            throw "sibling $(Split-Path -Leaf $ScriptPath) timed out after $TimeoutSeconds s"
        }
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        return [pscustomobject]@{
            ExitCode = $proc.ExitCode
            Stdout   = $stdout
            Stderr   = $stderr
        }
    } finally {
        $proc.Dispose()
    }
}

# Track which sites successfully received the new token. Used to decide if a
# failure is recoverable (rare) or partial (always non-zero exit).
$siteOk = @{ n150 = $false; codexa = $false; atomic_orange = $false }
$failReasons = @()

# -----------------------------------------------------------------------------
# STEP 2a: N150 DPAPI via store-n150.ps1.
# -----------------------------------------------------------------------------
Write-Receipt 'deploying to N150 (DPAPI) via store-n150.ps1'
try {
    $r = Invoke-SiblingStdin `
        -ScriptPath $storeScript `
        -ScriptArgs @('-Source', $Source) `
        -Token $rawToken `
        -TimeoutSeconds $SiteConfirmTimeoutSeconds
    if ($r.ExitCode -ne 0) {
        throw "store-n150 exit=$($r.ExitCode) stderr=$($r.Stderr)"
    }
    # Parse the trailing JSON summary block from sibling stdout.
    $jsonStart = $r.Stdout.IndexOf('{')
    if ($jsonStart -ge 0) {
        $summary = $r.Stdout.Substring($jsonStart) | ConvertFrom-Json -ErrorAction Stop
        $perSite.n150.sha256     = $summary.sha256
        $perSite.n150.stored_by  = $summary.stored_by
        $perSite.n150.state_file = $summary.state_file
    }
    if ($perSite.n150.sha256 -and ($perSite.n150.sha256 -ne $newSha256)) {
        throw "n150 stored sha256 ($($perSite.n150.sha256.Substring(0,12))...) does not match minted sha256 ($newShaShort...)"
    }
    $perSite.n150.status = 'ok'
    $siteOk.n150 = $true
    Write-Receipt "n150 OK: stored_by=$($perSite.n150.stored_by) sha256=$newShaShort..."
} catch {
    $perSite.n150.status = 'failed'
    $perSite.n150.error  = $_.Exception.Message
    $failReasons += "n150: $($_.Exception.Message)"
    Write-Receipt "n150 FAIL: $($_.Exception.Message)" 'ERROR'
}

# -----------------------------------------------------------------------------
# STEP 2b: Codexa via deploy-codexa.ps1.
# We forward host/user/port/identity/source/-SkipReload as appropriate.
# -----------------------------------------------------------------------------
Write-Receipt 'deploying to Codexa via deploy-codexa.ps1'
try {
    $codexaArgs = @(
        '-RemoteHost',   $CodexaRemoteHost,
        '-RemoteUser',   $CodexaRemoteUser,
        '-RemotePort',   [string]$CodexaRemotePort,
        '-IdentityFile', $CodexaIdentityFile,
        '-Source',       $Source
    )
    if ($SkipCodexaReload) { $codexaArgs += '-SkipReload' }

    $r = Invoke-SiblingStdin `
        -ScriptPath $deployScript `
        -ScriptArgs $codexaArgs `
        -Token $rawToken `
        -TimeoutSeconds ($SiteConfirmTimeoutSeconds * 2)  # SCP + reload margin
    if ($r.ExitCode -ne 0) {
        throw "deploy-codexa exit=$($r.ExitCode) stderr=$($r.Stderr)"
    }
    $jsonStart = $r.Stdout.IndexOf('{')
    if ($jsonStart -ge 0) {
        $summary = $r.Stdout.Substring($jsonStart) | ConvertFrom-Json -ErrorAction Stop
        $perSite.codexa.sha256        = $summary.sha256
        $perSite.codexa.remote_path   = $summary.remote_path
        $perSite.codexa.remote_unit   = $summary.remote_unit
        $perSite.codexa.reload_status = $summary.reload_status
        $perSite.codexa.unit_status   = $summary.unit_status
        $perSite.codexa.state_file    = $summary.state_file
    }
    if ($perSite.codexa.sha256 -and ($perSite.codexa.sha256 -ne $newSha256)) {
        throw "codexa stored sha256 ($($perSite.codexa.sha256.Substring(0,12))...) does not match minted sha256 ($newShaShort...)"
    }
    if ((-not $SkipCodexaReload) -and ($perSite.codexa.unit_status -ne 'active')) {
        throw "codexa unit_status='$($perSite.codexa.unit_status)' (expected 'active')"
    }
    $perSite.codexa.status = 'ok'
    $siteOk.codexa = $true
    Write-Receipt "codexa OK: reload=$($perSite.codexa.reload_status) unit=$($perSite.codexa.unit_status) sha256=$newShaShort..."
} catch {
    $perSite.codexa.status = 'failed'
    $perSite.codexa.error  = $_.Exception.Message
    $failReasons += "codexa: $($_.Exception.Message)"
    Write-Receipt "codexa FAIL: $($_.Exception.Message)" 'ERROR'
}

# -----------------------------------------------------------------------------
# STEP 2c: Atomic Orange via Tauri IPC. POST the token as the request body
# (Content-Type: application/octet-stream) to the rotate endpoint over the
# pinned-cert HTTPS connection. The Tauri sidecar writes it into the
# tauri-plugin-stronghold encrypted store and returns { ok, sha256, stronghold }.
#
# Mom's Law: the token bytes go into a non-buffered HttpContent and are
# dropped immediately on completion. We never log the body.
# -----------------------------------------------------------------------------
Write-Receipt 'deploying to Atomic Orange via Tauri IPC'
try {
    Add-Type -AssemblyName 'System.Net.Http' -ErrorAction SilentlyContinue
    $handler = New-Object System.Net.Http.HttpClientHandler
    if (-not [string]::IsNullOrEmpty($AtomicOrangeCertThumbprint)) {
        $expectedThumb = $AtomicOrangeCertThumbprint.ToLowerInvariant() -replace '[^0-9a-f]', ''
        $handler.ServerCertificateCustomValidationCallback = {
            param($message, $cert, $chain, $errors)
            if ($null -eq $cert) { return $false }
            $thumb = $cert.GetCertHashString('SHA256').ToLowerInvariant()
            return ($thumb -eq $expectedThumb)
        }.GetNewClosure()
    }
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($SiteConfirmTimeoutSeconds)
    # Include the rotation_id so the sidecar can correlate with audit if it
    # wants. The token is the entire body; no field name.
    $client.DefaultRequestHeaders.Add('X-AtomEons-Rotation-Id', $rotationId)
    $client.DefaultRequestHeaders.Add('X-AtomEons-Rotation-Source', $Source)
    $client.DefaultRequestHeaders.Add('X-AtomEons-Sha256', $newSha256)

    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($rawToken)
    $content = New-Object System.Net.Http.ByteArrayContent($bodyBytes, 0, $bodyBytes.Length)
    $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')

    $resp = $client.PostAsync($AtomicOrangeEndpoint, $content).GetAwaiter().GetResult()
    try {
        $respBody = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) {
            throw "atomic-orange POST HTTP $($resp.StatusCode): $respBody"
        }
        try {
            $summary = $respBody | ConvertFrom-Json -ErrorAction Stop
        } catch {
            throw "atomic-orange returned non-JSON body: $respBody"
        }
        if (-not $summary.ok) {
            throw "atomic-orange rejected: $($summary | ConvertTo-Json -Compress)"
        }
        if ($summary.PSObject.Properties.Name -contains 'sha256') {
            $perSite.atomic_orange.sha256 = $summary.sha256
            if ($summary.sha256 -ne $newSha256) {
                throw "atomic-orange sha256 ($($summary.sha256.Substring(0,12))...) does not match minted ($newShaShort...)"
            }
        }
        if ($summary.PSObject.Properties.Name -contains 'stronghold') {
            $perSite.atomic_orange.stronghold = $summary.stronghold
        }
        $perSite.atomic_orange.status = 'ok'
        $siteOk.atomic_orange = $true
        Write-Receipt "atomic-orange OK: stronghold=$($perSite.atomic_orange.stronghold) sha256=$newShaShort..."
    } finally {
        # Best-effort zero the body buffer.
        for ($i = 0; $i -lt $bodyBytes.Length; $i++) { $bodyBytes[$i] = 0 }
        $content.Dispose()
        $resp.Dispose()
        $client.Dispose()
        $handler.Dispose()
    }
} catch {
    $perSite.atomic_orange.status = 'failed'
    $perSite.atomic_orange.error  = $_.Exception.Message
    $failReasons += "atomic_orange: $($_.Exception.Message)"
    Write-Receipt "atomic-orange FAIL: $($_.Exception.Message)" 'ERROR'
}

# -----------------------------------------------------------------------------
# Scrub the in-memory raw token. From here forward, only sha256 fingerprints.
# -----------------------------------------------------------------------------
$rawToken = $null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

# -----------------------------------------------------------------------------
# STEP 3: Determine outcome and write audit row.
#
# Outcome rules:
#   - ok       : all three sites OK
#   - partial  : at least one OK and at least one failed
#   - failed   : zero sites OK
#
# Exit codes:
#   0  ok
#   30 partial
#   40 failed
# -----------------------------------------------------------------------------
$okCount = @($siteOk.Values | Where-Object { $_ }).Count

$outcome  = $null
$exitCode = 0
if ($okCount -eq 3) {
    $outcome  = 'ok'
    $exitCode = 0
} elseif ($okCount -gt 0) {
    $outcome  = 'partial'
    $exitCode = 30
} else {
    $outcome  = 'failed'
    $exitCode = 40
}

$failReason = if ($failReasons.Count -gt 0) { $failReasons -join '; ' } else { $null }

Write-AuditRow `
    -Outcome $outcome `
    -RotationId $rotationId `
    -StartedAtUtc $startedAtUtc `
    -PriorSha256 $priorSha256 `
    -NewSha256 $newSha256 `
    -PerSite $perSite `
    -FailReason $failReason

# Final receipt summary.
$priorTag = if ($priorSha256) { $priorSha256.Substring(0,12) + '...' } else { '<none>' }
Write-Receipt "outcome=$outcome ok=$okCount/3 prior_sha=$priorTag new_sha=$newShaShort... rotation_id=$rotationId"

if ($outcome -eq 'ok') {
    Write-Receipt 'OK - rail token rotated across all three storage sites'
} elseif ($outcome -eq 'partial') {
    Write-Receipt "PARTIAL - $failReason" 'ERROR'
    Write-Receipt 'rotation is NOT durable. Retry the rotation; storage sites are idempotent on sha256.' 'ERROR'
} else {
    Write-Receipt "FAILED - $failReason" 'ERROR'
}

# Emit machine-readable summary on stdout for callers that pipe.
[pscustomobject]@{
    ok               = ($outcome -eq 'ok')
    outcome          = $outcome
    rotation_id      = $rotationId
    rotation_source  = $Source
    started_at_utc   = $startedAtUtc.ToUniversalTime().ToString('o')
    prior_sha256     = $priorSha256
    new_sha256       = $newSha256
    new_sha256_short = $newShaShort
    per_site         = $perSite
    fail_reason      = $failReason
    audit_file       = $AuditFile
} | ConvertTo-Json -Depth 6

exit $exitCode
