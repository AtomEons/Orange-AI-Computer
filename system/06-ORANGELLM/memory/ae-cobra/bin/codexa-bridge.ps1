<#
codexa-bridge.ps1 — Æ Cobra N150-to-Codexa SSH tunnel

Run on the N150 cockpit host. Establishes an SSH tunnel to Codexa WSL2 and
port-forwards the loopback-only Æ Cobra daemon so the local Orange5 gateway
can proxy /v1/cobra/* through the rail.

Port mapping (operator spec, Night-1):
  N150 127.0.0.1:9100  ->  Codexa WSL2 127.0.0.1:7419  (Bun Flow Direct)
  N150 127.0.0.1:9101  ->  Codexa WSL2 127.0.0.1:7418  (llama.cpp server)

Both upstream ports are loopback-only inside WSL2. Port-forwarding from WSL2
to the Codexa host (so `ssh codexa` can reach them) is the operator's
preflight job (CODEXA_PREFLIGHT_AE_COBRA.md, netsh portproxy step). This
script does the second hop: Codexa-host -> N150 over SSH.

Doctrine refs:
  - Reach: gateway proxies /v1/cobra/* through rail; raw daemon never exposed.
  - 14-pt activation gate item 11 (no plain HTTP): SSH carries the tunnel.
  - 14-pt activation gate item 10 (no frontier reach): no outbound except
    the SSH control channel to a single named host.

Refuses on missing CODEXA_SSH_KEY env. Reaps the tunnel cleanly on Ctrl-C.

No fake-green: this script can be syntax-checked on N150 but its end-to-end
behavior requires the Codexa host reachable, the SSH key present, and the
daemon running on Codexa WSL2. Honest verification is the smoke-test that
fires AFTER the tunnel is up: a curl against 127.0.0.1:9100/healthz from
N150 should return the same JSON the daemon returns on Codexa loopback.
#>

[CmdletBinding()]
param(
    [string]$CodexaHost = $(if ($env:CODEXA_HOST) { $env:CODEXA_HOST } else { 'codexa' }),
    [string]$CodexaUser = $(if ($env:CODEXA_USER) { $env:CODEXA_USER } else { 'atom' }),
    [int]$BunLocalPort = 9100,
    [int]$BunRemotePort = 7419,
    [int]$LlamaLocalPort = 9101,
    [int]$LlamaRemotePort = 7418,
    [int]$KeepaliveSeconds = 30,
    [switch]$VerifyAfterUp
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Stamp {
    param([string]$Level, [string]$Message)
    $ts = [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    Write-Host "[$ts] [$Level] $Message"
}

# ---------------------------------------------------------------------------
# Gate 1 — refuse on missing CODEXA_SSH_KEY env
# ---------------------------------------------------------------------------
$keyPath = $env:CODEXA_SSH_KEY
if ([string]::IsNullOrWhiteSpace($keyPath)) {
    Write-Stamp 'FATAL' 'CODEXA_SSH_KEY env var is not set.'
    Write-Stamp 'FATAL' 'Refusing to start. Set the path to your Codexa SSH private key, e.g.:'
    Write-Stamp 'FATAL' '  $env:CODEXA_SSH_KEY = "C:\Users\a\.ssh\codexa_ed25519"'
    exit 2
}

if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    Write-Stamp 'FATAL' "CODEXA_SSH_KEY points to a path that does not exist: $keyPath"
    exit 2
}

# Permission hygiene check — warn if the key is world-readable on Windows.
# OpenSSH for Windows will refuse a key that ACL-fails its strict check.
try {
    $acl = Get-Acl -LiteralPath $keyPath
    $tooOpen = $acl.Access | Where-Object {
        $_.IdentityReference -notmatch 'SYSTEM|Administrators' -and
        $_.IdentityReference -notmatch [Regex]::Escape($env:USERNAME) -and
        $_.FileSystemRights -match 'Read|FullControl'
    }
    if ($tooOpen) {
        Write-Stamp 'WARN' "SSH key ACL grants read to identities beyond owner/SYSTEM/Administrators. OpenSSH may reject it."
        Write-Stamp 'WARN' "Fix with: icacls `"$keyPath`" /inheritance:r /grant:r `"$($env:USERNAME):(R)`""
    }
} catch {
    Write-Stamp 'WARN' "Could not inspect key ACL: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------
# Gate 2 — locate ssh.exe
# ---------------------------------------------------------------------------
$sshCmd = Get-Command -Name ssh.exe -ErrorAction SilentlyContinue
if (-not $sshCmd) {
    Write-Stamp 'FATAL' 'ssh.exe not found on PATH. Install Windows OpenSSH client (Settings -> Apps -> Optional features -> OpenSSH Client).'
    exit 2
}
$sshPath = $sshCmd.Source
Write-Stamp 'INFO' "Using ssh: $sshPath"

# ---------------------------------------------------------------------------
# Gate 3 — refuse if local ports are already bound
# ---------------------------------------------------------------------------
function Test-PortFree {
    param([int]$Port)
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    } catch {
        return $false
    }
}

foreach ($p in @($BunLocalPort, $LlamaLocalPort)) {
    if (-not (Test-PortFree -Port $p)) {
        Write-Stamp 'FATAL' "Local port $p on 127.0.0.1 is already in use. Refuse to start (another bridge running?)."
        Write-Stamp 'FATAL' "Diagnose: Get-NetTCPConnection -LocalPort $p"
        exit 2
    }
}

# ---------------------------------------------------------------------------
# Build ssh argument vector
# ---------------------------------------------------------------------------
# -N         : no remote command, just forward
# -T         : no PTY
# -o ...     : explicit options that survive any user-config drift
# -L         : local-to-remote forward
#
# We bind the local end to 127.0.0.1 explicitly. The Bun daemon and llama.cpp
# are loopback-only on Codexa; we keep the N150 end loopback-only too so the
# gateway is the only thing that can reach them.
$target = "$CodexaUser@$CodexaHost"

$sshArgs = @(
    '-N', '-T',
    '-i', $keyPath,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', "ServerAliveInterval=$KeepaliveSeconds",
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ConnectTimeout=10',
    '-L', "127.0.0.1:${BunLocalPort}:127.0.0.1:${BunRemotePort}",
    '-L', "127.0.0.1:${LlamaLocalPort}:127.0.0.1:${LlamaRemotePort}",
    $target
)

Write-Stamp 'INFO' "Forwarding 127.0.0.1:$BunLocalPort  -> $target -> 127.0.0.1:$BunRemotePort (Bun Flow Direct)"
Write-Stamp 'INFO' "Forwarding 127.0.0.1:$LlamaLocalPort -> $target -> 127.0.0.1:$LlamaRemotePort (llama.cpp server)"
Write-Stamp 'INFO' "Keepalive every ${KeepaliveSeconds}s, 3 missed -> drop. ExitOnForwardFailure=yes."

# ---------------------------------------------------------------------------
# Launch ssh as a child process we can reap
# ---------------------------------------------------------------------------
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = $sshPath
foreach ($a in $sshArgs) { [void]$psi.ArgumentList.Add($a) }
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.CreateNoWindow = $true

$proc = [System.Diagnostics.Process]::new()
$proc.StartInfo = $psi

# Stream ssh stderr to our console (ssh prints to stderr by default)
$stderrAction = {
    if (-not [string]::IsNullOrEmpty($EventArgs.Data)) {
        Write-Host "[ssh] $($EventArgs.Data)"
    }
}
$stdoutAction = {
    if (-not [string]::IsNullOrEmpty($EventArgs.Data)) {
        Write-Host "[ssh] $($EventArgs.Data)"
    }
}
$null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action $stderrAction
$null = Register-ObjectEvent -InputObject $proc -EventName OutputDataReceived -Action $stdoutAction

[void]$proc.Start()
$proc.BeginErrorReadLine()
$proc.BeginOutputReadLine()

Write-Stamp 'INFO' "ssh PID=$($proc.Id). Press Ctrl-C to tear the tunnel down cleanly."

# ---------------------------------------------------------------------------
# Clean reaper — Ctrl-C handler and exit trap
# ---------------------------------------------------------------------------
$script:reapedAlready = $false
function Invoke-Reaper {
    if ($script:reapedAlready) { return }
    $script:reapedAlready = $true
    Write-Stamp 'INFO' 'Tearing down tunnel...'
    try {
        if (-not $proc.HasExited) {
            $proc.CloseMainWindow() | Out-Null
            if (-not $proc.WaitForExit(2000)) {
                Write-Stamp 'WARN' 'ssh did not exit on close; killing.'
                $proc.Kill($true)
                $proc.WaitForExit(3000) | Out-Null
            }
        }
    } catch {
        Write-Stamp 'WARN' "Reaper exception: $($_.Exception.Message)"
    }
    try {
        Get-EventSubscriber -ErrorAction SilentlyContinue | Where-Object { $_.SourceObject -eq $proc } | Unregister-Event -Force -ErrorAction SilentlyContinue
    } catch { }
    Write-Stamp 'INFO' 'Tunnel down.'
}

# Console Ctrl-C handler
$ctrlcHandler = {
    param($sender, $eventArgs)
    $eventArgs.Cancel = $true   # don't kill PowerShell; we want to clean up first
    Invoke-Reaper
}
[Console]::CancelKeyPress += $ctrlcHandler

# Engine exit safety net (handles `exit`, parent-process kill, errors)
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action { Invoke-Reaper }

# ---------------------------------------------------------------------------
# Optional smoke test once the tunnel should be up (best-effort, ~5s)
# ---------------------------------------------------------------------------
if ($VerifyAfterUp) {
    Start-Sleep -Seconds 2
    $healthUrl = "http://127.0.0.1:$BunLocalPort/healthz"
    Write-Stamp 'INFO' "Verifying tunnel via $healthUrl"
    try {
        $resp = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 5 -UseBasicParsing
        if ($resp.StatusCode -eq 200) {
            Write-Stamp 'INFO'  "Tunnel verified: $healthUrl returned 200."
        } else {
            Write-Stamp 'WARN' "Tunnel reachable but status=$($resp.StatusCode). Daemon may not be ready."
        }
    } catch {
        Write-Stamp 'WARN' "Verify failed: $($_.Exception.Message). Tunnel may still be coming up, or daemon is down on Codexa."
    }
}

# ---------------------------------------------------------------------------
# Block on the ssh process; exit code mirrors ssh
# ---------------------------------------------------------------------------
try {
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 250
    }
} finally {
    Invoke-Reaper
}

$code = $proc.ExitCode
Write-Stamp 'INFO' "ssh exited with code $code."
exit $code
