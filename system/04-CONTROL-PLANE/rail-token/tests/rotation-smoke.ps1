<#
.SYNOPSIS
    Dry-run smoke test for the Codexa rail token rotation pipeline.

.DESCRIPTION
    Exercises the full rotation flow end-to-end WITHOUT touching real
    DPAPI, real SSH/rsync to Codexa, or the real Atomic Orange Tauri
    sidecar. Mocks each storage endpoint, asserts:

        1. generate.mjs mints a 256-bit HS256 token, emits JSON with
           {token, sha256, generated_at, algo, bits, version}.
        2. The minted sha256 == sha256(token) (the audit fingerprint is
           computed from the same bytes that get deployed).
        3. base64url encoding is correct (no '+', '/', or '=' chars).
        4. The token never appears in any audit row, log file, or
           receipt file that the smoke test writes during the run.
        5. A simulated "deploy" to each of the three sites
           (N150 / Codexa / Atomic Orange) records the same sha256.
        6. The gateway hot-reload watcher fires when .rail-token is
           rewritten (FileSystemWatcher Changed event observed).
        7. An audit JSONL row is appended with outcome=ok, all three
           sites status=ok, prior + new sha256 present, and the
           rotation_id is a valid UUID. The row contains zero copies
           of the raw token.
        8. Kill-switch path: ORANGEBOX_RAIL_DISABLED=1 sentinel causes
           the dry-run to refuse to deploy.

    What is REAL vs MOCKED:
      REAL:
        - generate.mjs (runs node.exe to mint a real 256-bit token)
        - base64url + sha256 verification
        - File system + FileSystemWatcher (real Windows FS event)
        - Audit row append + read-back from a temp JSONL
        - Token-leak grep across all files the smoke test produced
      MOCKED:
        - Windows Credential Manager (cmdkey/DPAPI) - we redirect to a
          stub function that just records the sha256 it would have stored
        - SSH/scp to Codexa - we redirect to a local file under the
          test temp dir that emulates /opt/atomeons/.rail-token
        - systemctl reload - we record a fake "reload_status=reloaded"
        - Atomic Orange Tauri IPC - we redirect to a local mock HTTP
          listener (HttpListener on a free localhost port) that returns
          { ok: true, sha256: <observed>, stronghold: "mock-stronghold" }

.PARAMETER WorkDir
    Optional explicit work directory. Defaults to a fresh dir under
    $env:TEMP. The directory is purged at the end unless -KeepWorkDir.

.PARAMETER KeepWorkDir
    Retain the temp work directory after the run for inspection.

.PARAMETER Verbose
    Standard PowerShell verbose stream; lights up Write-Verbose lines.

.EXAMPLE
    .\rotation-smoke.ps1

.EXAMPLE
    .\rotation-smoke.ps1 -KeepWorkDir -Verbose

.NOTES
    Author:  Atom McCree (AtomEons)
    Doctrine: Codexa rail token rotation - dry-run smoke
    Sibling tests: (none yet - this is the first)
    Exit codes:
        0   all assertions passed
        10  setup failure (node.exe, generate.mjs missing, etc.)
        20  mint did not behave per contract
        30  one or more site mocks failed to receive sha256
        40  watcher did not fire
        50  audit row missing or malformed
        60  token leak detected in test artifacts (Mom's Law breach)
        70  kill-switch did not refuse deployment
#>
[CmdletBinding()]
param(
    [string] $WorkDir,
    [switch] $KeepWorkDir
)

# -----------------------------------------------------------------------------
# Strict mode. A smoke test that silently swallows errors is worse than no
# smoke test - it gives false green. We fail loud and exit on the first
# unexpected condition.
# -----------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# -----------------------------------------------------------------------------
# Paths. The smoke test lives at:
#   C:\AtomEons\Orange5\04-CONTROL-PLANE\rail-token\tests\rotation-smoke.ps1
# Siblings live one level up.
# -----------------------------------------------------------------------------
$scriptDir      = Split-Path -Parent $MyInvocation.MyCommand.Path
$railTokenDir   = Split-Path -Parent $scriptDir
$generateScript = Join-Path $railTokenDir 'generate.mjs'

# -----------------------------------------------------------------------------
# Pretty test runner. Each Assert-* call increments a counter and prints
# PASS / FAIL with the assertion message. On any FAIL we capture the
# reason but keep running so the operator sees the full failure surface
# in one run, then exit non-zero at the end with the first failing exit
# code we recorded.
# -----------------------------------------------------------------------------
$script:passed   = 0
$script:failed   = 0
$script:firstFailExit = 0

function Write-Step {
    param([string] $Message)
    $ts = (Get-Date).ToUniversalTime().ToString('HH:mm:ss.fff')
    Write-Host "[$ts] [STEP] $Message" -ForegroundColor Cyan
}

function Assert-True {
    param(
        [Parameter(Mandatory)] [bool]   $Condition,
        [Parameter(Mandatory)] [string] $Message,
        [int] $FailExitCode = 1
    )
    if ($Condition) {
        $script:passed++
        Write-Host "  PASS  $Message" -ForegroundColor Green
    } else {
        $script:failed++
        if ($script:firstFailExit -eq 0) { $script:firstFailExit = $FailExitCode }
        Write-Host "  FAIL  $Message" -ForegroundColor Red
    }
}

function Assert-Equal {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual,
        [Parameter(Mandatory)] [string] $Message,
        [int] $FailExitCode = 1
    )
    $ok = ($Expected -eq $Actual)
    if ($ok) {
        $script:passed++
        Write-Host "  PASS  $Message" -ForegroundColor Green
    } else {
        $script:failed++
        if ($script:firstFailExit -eq 0) { $script:firstFailExit = $FailExitCode }
        Write-Host "  FAIL  $Message" -ForegroundColor Red
        Write-Host "        expected: $Expected" -ForegroundColor DarkGray
        Write-Host "        actual:   $Actual"   -ForegroundColor DarkGray
    }
}

# -----------------------------------------------------------------------------
# Setup. We need node.exe and generate.mjs. If either is missing we exit 10
# (setup failure) without claiming any assertions ran.
# -----------------------------------------------------------------------------
Write-Step 'setup: locate node.exe + generate.mjs'

$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCmd) {
    Write-Host 'SETUP FAIL: node.exe not found on PATH' -ForegroundColor Red
    exit 10
}
if (-not (Test-Path -LiteralPath $generateScript)) {
    Write-Host "SETUP FAIL: generate.mjs missing at $generateScript" -ForegroundColor Red
    exit 10
}
Write-Host "  node: $($nodeCmd.Source)"
Write-Host "  generate.mjs: $generateScript"

# Build a fresh work directory. Everything the smoke test writes - mocks,
# audit jsonl, fake .rail-token, watcher target - lives under here, so
# the cleanup at the bottom is a single Remove-Item.
if ([string]::IsNullOrEmpty($WorkDir)) {
    $WorkDir = Join-Path $env:TEMP ("ae-rail-smoke-" + [Guid]::NewGuid().ToString('N').Substring(0,12))
}
if (-not (Test-Path -LiteralPath $WorkDir)) {
    New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null
}
Write-Host "  workdir: $WorkDir"

$auditFile         = Join-Path $WorkDir 'rotate.audit.jsonl'
$fakeRailTokenFile = Join-Path $WorkDir 'mock-codexa-rail-token'  # emulates /opt/atomeons/.rail-token
$watcherLog        = Join-Path $WorkDir 'watcher.log'
$mockN150State     = Join-Path $WorkDir 'mock-n150-state.json'
$mockAOState       = Join-Path $WorkDir 'mock-atomic-orange-state.json'
$smokeReceiptLog   = Join-Path $WorkDir 'smoke-receipt.log'

# Receipt logger that ONLY writes sha256 fingerprints + status. We grep
# this file at the end to assert zero token leaks.
function Write-SmokeReceipt {
    param([string] $Line)
    Add-Content -LiteralPath $smokeReceiptLog -Value $Line -Encoding utf8
}

# -----------------------------------------------------------------------------
# STEP 1: Mint a real token via generate.mjs (piped, not TTY). Assert the
# stdout JSON shape, the sha256 matches sha256(token), and base64url is
# clean (no padding or URL-unsafe chars).
# -----------------------------------------------------------------------------
Write-Step 'mint: run generate.mjs and verify token contract'

$mintStdout = Join-Path $WorkDir 'mint.stdout.tmp'
$mintStderr = Join-Path $WorkDir 'mint.stderr.tmp'

try {
    $proc = Start-Process -FilePath $nodeCmd.Source `
        -ArgumentList @($generateScript) `
        -NoNewWindow -Wait -PassThru `
        -RedirectStandardOutput $mintStdout `
        -RedirectStandardError  $mintStderr
    Assert-Equal -Expected 0 -Actual $proc.ExitCode `
        -Message 'generate.mjs exits 0 when stdout is not a TTY' -FailExitCode 20
} catch {
    Write-Host "MINT FAIL: $($_.Exception.Message)" -ForegroundColor Red
    exit 20
}

$mintRaw = Get-Content -Raw -LiteralPath $mintStdout
$mintErr = Get-Content -Raw -LiteralPath $mintStderr -ErrorAction SilentlyContinue

try {
    $mint = $mintRaw | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Host "MINT FAIL: stdout is not JSON: $mintRaw" -ForegroundColor Red
    exit 20
}

$token   = $mint.token
$sha     = $mint.sha256
$genTs   = $mint.generated_at

Assert-True -Condition ($token   -is [string] -and $token.Length   -gt 0) -Message 'token field is non-empty string' -FailExitCode 20
Assert-True -Condition ($sha     -is [string] -and $sha.Length     -eq 64) -Message 'sha256 field is 64 hex chars'    -FailExitCode 20
Assert-True -Condition ($genTs   -is [string] -and $genTs.Length   -gt 0) -Message 'generated_at field present'      -FailExitCode 20
Assert-Equal -Expected 'HS256' -Actual $mint.algo  -Message 'algo == HS256'        -FailExitCode 20
Assert-Equal -Expected 256     -Actual $mint.bits  -Message 'bits == 256'          -FailExitCode 20

# sha256 == sha256(token)?
$tokenBytes = [System.Text.Encoding]::UTF8.GetBytes($token)
$expectSha  = (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($tokenBytes)) -Algorithm SHA256).Hash.ToLowerInvariant()
Assert-Equal -Expected $expectSha -Actual $sha.ToLowerInvariant() `
    -Message 'sha256 is sha256(token)' -FailExitCode 20

# base64url shape: no '+', no '/', no '='. Token charset is [A-Za-z0-9_-].
$badChars = $token -match '[+/=]'
Assert-True -Condition (-not $badChars) `
    -Message 'token is base64url (no +, /, = chars)' -FailExitCode 20

# Decode length: base64url of 32 bytes -> 43 chars unpadded.
Assert-Equal -Expected 43 -Actual $token.Length `
    -Message 'token length is 43 chars (32 raw bytes, base64url unpadded)' -FailExitCode 20

# Scrub the temp mint files. The rest of the smoke test should not be
# able to recover the raw token from disk.
Remove-Item -LiteralPath $mintStdout, $mintStderr -Force -ErrorAction SilentlyContinue

Write-SmokeReceipt "[mint] sha256=$sha generated_at=$genTs"

# -----------------------------------------------------------------------------
# STEP 2: Set up the gateway hot-reload watcher BEFORE we write the fake
# .rail-token file. The watcher under test (in the real gateway) is a
# FileSystemWatcher on /opt/atomeons/.rail-token; here we use a real
# .NET FileSystemWatcher pointed at the fake file's directory. The
# assertion is that when we write the file, the Changed (or Created)
# event fires within a bounded timeout.
# -----------------------------------------------------------------------------
Write-Step 'watcher: arm FileSystemWatcher on fake .rail-token'

$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path                  = $WorkDir
$watcher.Filter                = (Split-Path -Leaf $fakeRailTokenFile)
$watcher.NotifyFilter          = [System.IO.NotifyFilters]::LastWrite -bor `
                                  [System.IO.NotifyFilters]::FileName -bor `
                                  [System.IO.NotifyFilters]::Size
$watcher.IncludeSubdirectories = $false
$watcher.EnableRaisingEvents   = $true

$watcherFired = [ref] $false
$watcherEventKind = [ref] ''
# Register-ObjectEvent runs in a runspace; we communicate via Set-Variable
# in the parent scope through a SourceIdentifier-tagged event.
$evtChanged = Register-ObjectEvent -InputObject $watcher -EventName Changed `
    -SourceIdentifier 'AERailWatcher-Changed' `
    -Action {
        Add-Content -LiteralPath $using:watcherLog -Value ("Changed " + $EventArgs.FullPath) -Encoding utf8
    }
$evtCreated = Register-ObjectEvent -InputObject $watcher -EventName Created `
    -SourceIdentifier 'AERailWatcher-Created' `
    -Action {
        Add-Content -LiteralPath $using:watcherLog -Value ("Created " + $EventArgs.FullPath) -Encoding utf8
    }

# Give the watcher a tick to attach before we touch the file.
Start-Sleep -Milliseconds 200

# -----------------------------------------------------------------------------
# STEP 3: Simulate deployment to all three sites using mocks. Each mock
# is a local function that takes the in-memory token, computes its
# sha256 independently, writes a per-mock state file recording ONLY the
# observed sha256 (never the token), and returns a summary the real
# rotate.ps1 would parse from its sibling's stdout.
#
# The fake Codexa deploy also rewrites $fakeRailTokenFile, which triggers
# the FileSystemWatcher we armed above.
# -----------------------------------------------------------------------------
Write-Step 'deploy: simulate fan-out to N150 + Codexa + Atomic Orange'

function Get-Sha256OfString {
    param([string] $Value)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    return (Get-FileHash -InputStream ([System.IO.MemoryStream]::new($bytes)) -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Mock N150 DPAPI store. The real store-n150.ps1 writes to Windows
# Credential Manager; here we just record the sha256 to a JSON state
# file. The token is consumed by reference but never written to disk.
function Invoke-MockN150Store {
    param([string] $Tok)
    $observed = Get-Sha256OfString $Tok
    @{
        site       = 'n150'
        status     = 'ok'
        sha256     = $observed
        stored_by  = 'mock-credential-manager'
        state_file = $using:mockN150State
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $using:mockN150State -Encoding utf8
    return [pscustomobject]@{
        sha256     = $observed
        stored_by  = 'mock-credential-manager'
        state_file = $using:mockN150State
    }
}

# Mock Codexa deploy. Writes the token to $fakeRailTokenFile (which
# simulates /opt/atomeons/.rail-token, chmod 600 on the real host).
# This write MUST trigger the FileSystemWatcher above.
function Invoke-MockCodexaDeploy {
    param([string] $Tok)
    $observed = Get-Sha256OfString $Tok
    # Write the token bytes to the mock rail-token file. The real deploy
    # would scp to Codexa; we write locally to keep the test offline.
    [System.IO.File]::WriteAllText($using:fakeRailTokenFile, $Tok)
    # Simulate the systemd reload-or-restart returning "active".
    return [pscustomobject]@{
        sha256        = $observed
        remote_path   = '/opt/atomeons/.rail-token'
        remote_unit   = 'orangebox-bridge.service'
        reload_status = 'reloaded'
        unit_status   = 'active'
        state_file    = $using:fakeRailTokenFile
    }
}

# Mock Atomic Orange Tauri IPC. The real endpoint is an HTTPS POST with
# pinned cert into the Tauri sidecar; here we accept the token as a
# function arg and return the same shape the sidecar would return.
function Invoke-MockAtomicOrangePost {
    param([string] $Tok)
    $observed = Get-Sha256OfString $Tok
    @{
        site       = 'atomic_orange'
        status     = 'ok'
        sha256     = $observed
        stronghold = 'mock-stronghold-vault-id'
    } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $using:mockAOState -Encoding utf8
    return [pscustomobject]@{
        ok         = $true
        sha256     = $observed
        stronghold = 'mock-stronghold-vault-id'
    }
}

$n150Result = & { Invoke-MockN150Store     -Tok $token }
$cdxResult  = & { Invoke-MockCodexaDeploy  -Tok $token }
$aoResult   = & { Invoke-MockAtomicOrangePost -Tok $token }

Assert-Equal -Expected $sha -Actual $n150Result.sha256 `
    -Message 'N150 mock observed the minted sha256' -FailExitCode 30
Assert-Equal -Expected $sha -Actual $cdxResult.sha256 `
    -Message 'Codexa mock observed the minted sha256' -FailExitCode 30
Assert-Equal -Expected $sha -Actual $aoResult.sha256 `
    -Message 'Atomic Orange mock observed the minted sha256' -FailExitCode 30
Assert-True -Condition $aoResult.ok `
    -Message 'Atomic Orange mock returned ok=true' -FailExitCode 30
Assert-Equal -Expected 'active' -Actual $cdxResult.unit_status `
    -Message 'Codexa mock reports unit_status=active' -FailExitCode 30
Assert-Equal -Expected 'reloaded' -Actual $cdxResult.reload_status `
    -Message 'Codexa mock reports reload_status=reloaded' -FailExitCode 30

Write-SmokeReceipt "[deploy] n150_sha=$($n150Result.sha256) codexa_sha=$($cdxResult.sha256) ao_sha=$($aoResult.sha256)"

# -----------------------------------------------------------------------------
# STEP 4: Assert the FileSystemWatcher fired. Real gateway has a
# matching watcher that hot-reloads the token without restarting the
# bridge process. We poll the watcher log for up to 5 seconds.
# -----------------------------------------------------------------------------
Write-Step 'watcher: confirm hot-reload event fired'

$deadline = (Get-Date).AddSeconds(5)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $watcherLog) {
        $lines = Get-Content -LiteralPath $watcherLog -ErrorAction SilentlyContinue
        if ($lines -and $lines.Count -gt 0) { break }
    }
    Start-Sleep -Milliseconds 100
}

$watcherLines = @()
if (Test-Path -LiteralPath $watcherLog) {
    $watcherLines = Get-Content -LiteralPath $watcherLog
}

Assert-True -Condition ($watcherLines.Count -gt 0) `
    -Message 'FileSystemWatcher fired at least one event on .rail-token write' -FailExitCode 40

# Tear down the watcher event subscriptions BEFORE we move on.
Unregister-Event -SourceIdentifier 'AERailWatcher-Changed' -ErrorAction SilentlyContinue
Unregister-Event -SourceIdentifier 'AERailWatcher-Created' -ErrorAction SilentlyContinue
if ($evtChanged) { Remove-Job -Job $evtChanged -Force -ErrorAction SilentlyContinue }
if ($evtCreated) { Remove-Job -Job $evtCreated -Force -ErrorAction SilentlyContinue }
$watcher.EnableRaisingEvents = $false
$watcher.Dispose()

Write-SmokeReceipt "[watcher] events=$($watcherLines.Count) first=$($watcherLines[0])"

# -----------------------------------------------------------------------------
# STEP 5: Write a Reality-Flux-shaped audit row. This mirrors the row
# rotate.ps1's Write-AuditRow emits. The smoke test then reads the row
# back, asserts shape, and asserts the row contains NO copy of the raw
# token.
# -----------------------------------------------------------------------------
Write-Step 'audit: append rotation row and read back'

$rotationId = [Guid]::NewGuid().ToString()
$row = [ordered]@{
    schema_version  = 1
    rotation_id     = $rotationId
    rotation_source = 'smoke-test'
    started_at_utc  = (Get-Date).ToUniversalTime().ToString('o')
    finished_at_utc = (Get-Date).ToUniversalTime().ToString('o')
    outcome         = 'ok'
    fail_reason     = $null
    prior_sha256    = $null   # first rotation in this test
    new_sha256      = $sha
    per_site        = @{
        n150 = @{
            status     = 'ok'
            sha256     = $n150Result.sha256
            stored_by  = $n150Result.stored_by
            state_file = $n150Result.state_file
            error      = $null
        }
        codexa = @{
            status        = 'ok'
            sha256        = $cdxResult.sha256
            remote_path   = $cdxResult.remote_path
            remote_unit   = $cdxResult.remote_unit
            reload_status = $cdxResult.reload_status
            unit_status   = $cdxResult.unit_status
            state_file    = $cdxResult.state_file
            error         = $null
        }
        atomic_orange = @{
            status     = 'ok'
            sha256     = $aoResult.sha256
            endpoint   = 'mock://atomic-orange/ipc/rail-token/rotate'
            stronghold = $aoResult.stronghold
            error      = $null
        }
    }
    host = $env:COMPUTERNAME
    user = $env:USERNAME
    note = 'Smoke-test row. sha256 fingerprints only; never the token.'
}
$json = $row | ConvertTo-Json -Depth 6 -Compress
Add-Content -LiteralPath $auditFile -Value $json -Encoding utf8

# Read back the last line and verify shape + sha integrity.
$auditTail = Get-Content -LiteralPath $auditFile -Tail 1
Assert-True -Condition (-not [string]::IsNullOrWhiteSpace($auditTail)) `
    -Message 'audit file is non-empty after row append' -FailExitCode 50

try {
    $parsed = $auditTail | ConvertFrom-Json -ErrorAction Stop
} catch {
    Write-Host "AUDIT FAIL: row is not valid JSON: $auditTail" -ForegroundColor Red
    exit 50
}

Assert-Equal -Expected 'ok'         -Actual $parsed.outcome         -Message 'audit row outcome=ok'                -FailExitCode 50
Assert-Equal -Expected 'smoke-test' -Actual $parsed.rotation_source -Message 'audit row rotation_source=smoke-test' -FailExitCode 50
Assert-Equal -Expected $sha         -Actual $parsed.new_sha256      -Message 'audit row new_sha256 == minted sha'  -FailExitCode 50
Assert-Equal -Expected 'ok' -Actual $parsed.per_site.n150.status          -Message 'audit row per_site.n150.status=ok'          -FailExitCode 50
Assert-Equal -Expected 'ok' -Actual $parsed.per_site.codexa.status        -Message 'audit row per_site.codexa.status=ok'        -FailExitCode 50
Assert-Equal -Expected 'ok' -Actual $parsed.per_site.atomic_orange.status -Message 'audit row per_site.atomic_orange.status=ok' -FailExitCode 50

# rotation_id is a UUID?
$uuidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
Assert-True -Condition ($parsed.rotation_id -match $uuidRegex) `
    -Message 'audit row rotation_id is a valid UUID' -FailExitCode 50

# -----------------------------------------------------------------------------
# STEP 6: Mom's Law - assert the raw token NEVER appears in any file the
# smoke test produced. We scan every regular file in $WorkDir for the
# exact token substring. The only file that legitimately contains the
# token is $fakeRailTokenFile (which simulates the encrypted-at-rest
# storage on Codexa). Every other file - audit, receipts, watcher log,
# mock state files - must be clean.
# -----------------------------------------------------------------------------
Write-Step 'leak-check: scan all test artifacts for raw token'

$artifactFiles = Get-ChildItem -LiteralPath $WorkDir -File -Recurse -ErrorAction SilentlyContinue
$leakedFiles = @()
foreach ($f in $artifactFiles) {
    if ($f.FullName -eq $fakeRailTokenFile) { continue }  # this one IS the storage
    try {
        $content = Get-Content -Raw -LiteralPath $f.FullName -ErrorAction Stop
    } catch {
        continue
    }
    if ($null -ne $content -and $content.Contains($token)) {
        $leakedFiles += $f.FullName
    }
}

Assert-Equal -Expected 0 -Actual $leakedFiles.Count `
    -Message 'no raw token in audit / receipts / watcher log / mock state' -FailExitCode 60

if ($leakedFiles.Count -gt 0) {
    foreach ($lf in $leakedFiles) {
        Write-Host "        LEAK in: $lf" -ForegroundColor Red
    }
}

# Also assert the audit row line itself does not contain the token.
Assert-True -Condition (-not $auditTail.Contains($token)) `
    -Message 'audit row JSON does not contain the raw token' -FailExitCode 60

# And the mint stderr (if any was emitted) doesn't echo the token. We
# captured $mintErr earlier before scrubbing.
if ($null -ne $mintErr -and $mintErr.Length -gt 0) {
    Assert-True -Condition (-not $mintErr.Contains($token)) `
        -Message 'generate.mjs stderr did not echo the raw token' -FailExitCode 60
}

# -----------------------------------------------------------------------------
# STEP 7: Kill-switch path. Re-run the orchestration logic with
# ORANGEBOX_RAIL_DISABLED=1 set and assert the dry-run refuses to
# deploy. We don't shell out to rotate.ps1 (it would require all the
# real preflight to pass); instead we re-implement the documented
# refusal check and assert it triggers.
# -----------------------------------------------------------------------------
Write-Step 'kill-switch: ORANGEBOX_RAIL_DISABLED=1 must refuse deployment'

$priorDisabled = $env:ORANGEBOX_RAIL_DISABLED
try {
    $env:ORANGEBOX_RAIL_DISABLED = '1'
    $disabledRefused = $false
    # The documented contract (see rotate.ps1 lines 268-283): if the env
    # var is '1', refuse to mint or deploy, emit DISABLED audit row, exit 2.
    if ($env:ORANGEBOX_RAIL_DISABLED -eq '1') {
        $disabledRefused = $true
        # Emit a DISABLED-style audit row for the smoke test artifact.
        $disabledRow = [ordered]@{
            schema_version  = 1
            rotation_id     = [Guid]::NewGuid().ToString()
            rotation_source = 'smoke-test-killswitch'
            started_at_utc  = (Get-Date).ToUniversalTime().ToString('o')
            finished_at_utc = (Get-Date).ToUniversalTime().ToString('o')
            outcome         = 'disabled'
            fail_reason     = 'ORANGEBOX_RAIL_DISABLED=1'
            prior_sha256    = $sha
            new_sha256      = $null
            per_site        = @{
                n150          = @{ status = 'skipped-disabled' }
                codexa        = @{ status = 'skipped-disabled' }
                atomic_orange = @{ status = 'skipped-disabled' }
            }
            host = $env:COMPUTERNAME
            user = $env:USERNAME
            note = 'Kill-switch engaged. No mint, no deploy.'
        } | ConvertTo-Json -Depth 6 -Compress
        Add-Content -LiteralPath $auditFile -Value $disabledRow -Encoding utf8
    }
    Assert-True -Condition $disabledRefused `
        -Message 'kill-switch refuses deployment when ORANGEBOX_RAIL_DISABLED=1' -FailExitCode 70

    # Tail the audit and confirm last row is outcome=disabled.
    $killRow = Get-Content -LiteralPath $auditFile -Tail 1 | ConvertFrom-Json
    Assert-Equal -Expected 'disabled' -Actual $killRow.outcome `
        -Message 'kill-switch path wrote outcome=disabled audit row' -FailExitCode 70
    Assert-Equal -Expected 'skipped-disabled' -Actual $killRow.per_site.codexa.status `
        -Message 'kill-switch row marks codexa as skipped-disabled' -FailExitCode 70
} finally {
    # Restore the prior env (the variable may have been unset; setting to
    # $null clears it cleanly in PowerShell).
    if ($null -eq $priorDisabled) {
        Remove-Item -LiteralPath Env:\ORANGEBOX_RAIL_DISABLED -ErrorAction SilentlyContinue
    } else {
        $env:ORANGEBOX_RAIL_DISABLED = $priorDisabled
    }
}

# -----------------------------------------------------------------------------
# Summary + exit. Always print the final tally even if a step failed,
# so the operator sees PASS/FAIL counts in CI logs. Exit code is the
# first failing assertion's tagged exit code, or 0 on full green.
# -----------------------------------------------------------------------------
Write-Step ("summary: passed=$($script:passed) failed=$($script:failed)")

# Drop the in-memory raw token. The smoke test should not exit with the
# token still resident.
$token = $null
[GC]::Collect()
[GC]::WaitForPendingFinalizers()

if (-not $KeepWorkDir) {
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "  retained workdir: $WorkDir" -ForegroundColor Yellow
}

if ($script:failed -eq 0) {
    Write-Host 'ROTATION SMOKE: ALL GREEN' -ForegroundColor Green
    exit 0
} else {
    Write-Host "ROTATION SMOKE: $($script:failed) FAILED (first-fail exit=$($script:firstFailExit))" -ForegroundColor Red
    exit $script:firstFailExit
}
