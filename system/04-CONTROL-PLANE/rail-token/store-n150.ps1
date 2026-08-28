<#
.SYNOPSIS
    Store ORANGEBOX_RAIL_TOKEN in Windows Credential Manager (DPAPI-protected)
    and write a non-secret sha256 fingerprint state file for verification.

.DESCRIPTION
    Reads the rail token from stdin (never accepted as a parameter, never echoed,
    never logged). Persists it via the CredentialManager module's
    New-StoredCredential (preferred) or falls back to the built-in cmdkey.exe
    wrapper. Computes the sha256 of the token bytes and writes ONLY that
    fingerprint, plus rotation metadata, to a non-secret state file. The token
    itself never touches disk in plaintext or appears in any log line.

    This is the N150-side anchor of the Codexa rail token rotation doctrine.
    The same token is propagated to Codexa (/opt/atomeons/.rail-token) and the
    Atomic Orange Tauri stronghold by sibling scripts; this script owns the
    operator-machine half only.

    Mom's Law: tokens never appear in logs. Receipts log only sha256
    fingerprints. Storage is encrypted at rest (DPAPI, current-user scope).

.PARAMETER TargetName
    The Windows Credential Manager target name. Defaults to
    'AtomEons:OrangeboxRailToken'.

.PARAMETER UserName
    The username slot in the credential entry. Defaults to 'ORANGEBOX_RAIL_TOKEN'.
    Cosmetic only - the token lives in the password slot, DPAPI-encrypted.

.PARAMETER StateFile
    Path to the non-secret fingerprint state file. Defaults to
    C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\store-n150.state.json.

.PARAMETER Source
    Free-form rotation source tag written into the state file (e.g.
    'manual', 'scheduled-task', 'rotation-7d'). Defaults to 'manual'.

.PARAMETER KillSwitch
    If set, refuses to store and instead emits a state file marked
    DISABLED=true. Used when ORANGEBOX_RAIL_DISABLED=1 is in force.

.EXAMPLE
    'eyJhbGciOi...token-bytes...' | .\store-n150.ps1

.EXAMPLE
    Get-Content -Raw new-token.txt | .\store-n150.ps1 -Source 'rotation-7d'

.NOTES
    Author:   Atom McCree (AtomEons)
    Receipt:  Wave 2 close - rail token blocker resolution
    Doctrine: Codexa rail token rotation, 04-CONTROL-PLANE/rail-token
#>
[CmdletBinding()]
param(
    [string] $TargetName = 'AtomEons:OrangeboxRailToken',
    [string] $UserName   = 'ORANGEBOX_RAIL_TOKEN',
    [string] $StateFile  = 'C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\state\store-n150.state.json',
    [string] $Source     = 'manual',
    [switch] $KillSwitch
)

# -----------------------------------------------------------------------------
# Strict mode. Any error aborts; we do not want partial state on disk.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Logging helpers. NEVER write the token. Only fingerprints and status.
# -----------------------------------------------------------------------------
function Write-Receipt {
    param([string] $Message, [string] $Level = 'INFO')
    $ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Write-Host "[$ts] [$Level] store-n150: $Message"
}

function Assert-NoTokenInString {
    param([string] $Candidate, [string] $TokenSha)
    # Defense-in-depth: if any log/receipt string somehow contains the full
    # token sha (which is fine), that is allowed; raw token shape (long base64url)
    # leaking would be a bug. We do not have the raw token in scope here.
    # This is a placeholder hook for future linting of receipts.
    return
}

# -----------------------------------------------------------------------------
# Resolve state directory; create if missing.
# -----------------------------------------------------------------------------
$stateDir = Split-Path -Parent $StateFile
if (-not (Test-Path -LiteralPath $stateDir)) {
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    Write-Receipt "created state directory: $stateDir"
}

# -----------------------------------------------------------------------------
# Kill-switch path. Refuse to store. Emit a disabled state record.
# -----------------------------------------------------------------------------
$envDisabled = $env:ORANGEBOX_RAIL_DISABLED
if ($KillSwitch -or ($envDisabled -eq '1')) {
    $disabledState = [ordered]@{
        target_name      = $TargetName
        user_name        = $UserName
        disabled         = $true
        reason           = if ($KillSwitch) { 'KillSwitch parameter' } else { 'ORANGEBOX_RAIL_DISABLED=1' }
        sha256           = $null
        prior_sha256     = $null
        rotated_at_utc   = (Get-Date).ToUniversalTime().ToString('o')
        rotation_source  = $Source
        host             = $env:COMPUTERNAME
        user             = $env:USERNAME
    }
    $disabledState | ConvertTo-Json -Depth 4 | Out-File -FilePath $StateFile -Encoding utf8 -Force
    Write-Receipt "kill-switch engaged - refusing to store rail token; state file marked DISABLED" 'WARN'
    exit 2
}

# -----------------------------------------------------------------------------
# Read token from stdin ONLY. Never from a parameter, env, or file path.
# Trim trailing newline only; preserve any internal structure.
# -----------------------------------------------------------------------------
if ([Console]::IsInputRedirected -eq $false) {
    Write-Receipt "no stdin detected - token must be piped in. Aborting." 'ERROR'
    Write-Receipt "usage: 'tokenvalue' | .\store-n150.ps1" 'ERROR'
    exit 64
}

$token = [Console]::In.ReadToEnd()
if ([string]::IsNullOrEmpty($token)) {
    Write-Receipt "stdin was empty - no token to store. Aborting." 'ERROR'
    exit 65
}

# Trim ONLY surrounding whitespace/newlines; token bytes themselves preserved.
$token = $token.Trim()

if ($token.Length -lt 32) {
    Write-Receipt "token shorter than 32 chars - refusing (weak token). Aborting." 'ERROR'
    # Zero out the suspect string ASAP.
    $token = $null
    [GC]::Collect()
    exit 66
}

# -----------------------------------------------------------------------------
# Compute sha256 fingerprint over the UTF-8 token bytes.
# This fingerprint is the ONLY thing we ever log or persist non-secretly.
# -----------------------------------------------------------------------------
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha.ComputeHash($tokenBytes)
} finally {
    if ($null -ne $sha) { $sha.Dispose() }
    # Best-effort zero of byte buffer (managed memory; not bulletproof).
    for ($i = 0; $i -lt $tokenBytes.Length; $i++) { $tokenBytes[$i] = 0 }
}
$tokenSha256 = ([System.BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()

# Short fingerprint for human-readable receipts.
$tokenShaShort = $tokenSha256.Substring(0, 12)
Write-Receipt "computed sha256 fingerprint: $tokenShaShort... (full sha will be written to state file)"

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
    Write-Receipt "NEW token sha256 matches prior - no rotation actually occurred. Continuing to ensure CredMan slot is current." 'WARN'
}

# -----------------------------------------------------------------------------
# Store via CredentialManager module (preferred). Falls back to cmdkey wrapper.
# Both paths use DPAPI under the hood for the current user.
# -----------------------------------------------------------------------------
$storedBy = $null

$credMgrModule = Get-Module -ListAvailable -Name 'CredentialManager' | Select-Object -First 1
if ($null -ne $credMgrModule) {
    try {
        Import-Module CredentialManager -ErrorAction Stop
        $secure = ConvertTo-SecureString -String $token -AsPlainText -Force
        # New-StoredCredential expects -Password as SecureString (DPAPI).
        New-StoredCredential `
            -Target   $TargetName `
            -UserName $UserName `
            -SecurePassword $secure `
            -Persist  LocalMachine `
            -Type     Generic `
            -ErrorAction Stop | Out-Null
        $storedBy = 'CredentialManager.New-StoredCredential'
        Write-Receipt "stored via $storedBy (target=$TargetName, persist=LocalMachine, DPAPI)"
    } catch {
        Write-Receipt "CredentialManager module present but New-StoredCredential failed: $($_.Exception.Message)" 'WARN'
        Write-Receipt "falling back to cmdkey wrapper..." 'WARN'
    }
}

if ($null -eq $storedBy) {
    # cmdkey wrapper path. cmdkey accepts the secret on its argv, which is the
    # one place we cannot fully avoid; but cmdkey is the OS-shipped tool and is
    # the documented fallback. Process argv is visible only to the same user
    # session; the credential itself lands DPAPI-encrypted.
    try {
        # Use /generic for application-defined credentials.
        $cmdkeyArgs = @(
            "/generic:$TargetName",
            "/user:$UserName",
            "/pass:$token"
        )
        $proc = Start-Process -FilePath 'cmdkey.exe' `
            -ArgumentList $cmdkeyArgs `
            -NoNewWindow -Wait -PassThru `
            -RedirectStandardOutput ([System.IO.Path]::GetTempFileName()) `
            -RedirectStandardError  ([System.IO.Path]::GetTempFileName())
        if ($proc.ExitCode -ne 0) {
            throw "cmdkey.exe exited with code $($proc.ExitCode)"
        }
        $storedBy = 'cmdkey.exe /generic'
        Write-Receipt "stored via $storedBy (target=$TargetName)"
    } catch {
        Write-Receipt "cmdkey fallback failed: $($_.Exception.Message)" 'ERROR'
        # Best-effort: scrub token from memory before exit.
        $token = $null
        [GC]::Collect()
        exit 70
    }
}

# -----------------------------------------------------------------------------
# Scrub the in-memory token string. .NET strings are immutable and may be
# interned, but we drop our last reference and force a collection.
# -----------------------------------------------------------------------------
$token = $null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

# -----------------------------------------------------------------------------
# Write the non-secret state file. Contains ONLY:
#   - new sha256 fingerprint
#   - prior sha256 fingerprint (for audit chain)
#   - target name (cosmetic locator)
#   - rotation metadata
# NEVER contains the token itself.
# -----------------------------------------------------------------------------
$state = [ordered]@{
    schema_version   = 1
    target_name      = $TargetName
    user_name        = $UserName
    disabled         = $false
    sha256           = $tokenSha256
    sha256_short     = $tokenShaShort
    prior_sha256     = $priorSha256
    rotated_at_utc   = (Get-Date).ToUniversalTime().ToString('o')
    rotation_source  = $Source
    stored_by        = $storedBy
    host             = $env:COMPUTERNAME
    user             = $env:USERNAME
    note             = 'Non-secret state file. Contains sha256 fingerprint only; never the token.'
}

$state | ConvertTo-Json -Depth 4 | Out-File -FilePath $StateFile -Encoding utf8 -Force

# Lock down the state file ACL to the current user.
try {
    $acl = Get-Acl -LiteralPath $StateFile
    $acl.SetAccessRuleProtection($true, $false)  # disable inheritance, don't copy
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
Write-Receipt "rotation receipt: prior_sha=$(if ($priorSha256) { $priorSha256.Substring(0,12) + '...' } else { '<none>' }) new_sha=$tokenShaShort... source=$Source"
Write-Receipt "OK - rail token stored on N150 via $storedBy"

# Emit machine-readable summary on stdout for callers that pipe.
[pscustomobject]@{
    ok               = $true
    target_name      = $TargetName
    sha256           = $tokenSha256
    sha256_short     = $tokenShaShort
    prior_sha256     = $priorSha256
    rotated_at_utc   = $state.rotated_at_utc
    rotation_source  = $Source
    stored_by        = $storedBy
    state_file       = $StateFile
} | ConvertTo-Json -Depth 3

exit 0
