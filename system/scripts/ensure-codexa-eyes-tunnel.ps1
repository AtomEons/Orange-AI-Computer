[CmdletBinding()]
param(
  [string]$CodexaHost = '10.0.0.4',
  [string]$CodexaUser = 'Atom',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519'),
  [int]$LocalPort = 7440,
  [int]$RemotePort = 7440
)

$ErrorActionPreference = 'Stop'
$knownHosts = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\codexa-vulkan-known-hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshBase = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$knownHosts")
$target = "$CodexaUser@$CodexaHost"

function Test-EyesHealth {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health" -TimeoutSec 3
    return $health.ok -eq $true -and $health.service -eq 'colpali-ingest'
  } catch { return $false }
}

if (Test-EyesHealth) {
  [pscustomobject]@{ status = 'VERIFIED'; endpoint = "http://127.0.0.1:$LocalPort"; transport = 'ssh-loopback-tunnel'; reused = $true } | ConvertTo-Json
  exit 0
}

# Remove only the retired Orange5 Bun facade. Never kill an unrelated owner.
$listeners = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue
foreach ($listener in $listeners) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if ($process.Name -eq 'bun.exe' -and $process.CommandLine -match 'colpali-service\\proxy-to-codexa\.mjs') {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

$existing = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'ssh.exe' -and $_.CommandLine -match "127\.0\.0\.1:$LocalPort`:127\.0\.0\.1:$RemotePort"
}
$existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# Prove the remote organ before opening a local tunnel.
& ssh @sshBase $target "curl.exe --silent --fail --max-time 5 http://127.0.0.1:$RemotePort/health" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Codexa AE Eyes is not healthy on remote loopback' }

$tunnelArgs = @('-N') + $sshBase + @(
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=30',
  '-o', 'ServerAliveCountMax=3',
  '-L', "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort",
  $target
)
Start-Process ssh.exe -ArgumentList $tunnelArgs -WindowStyle Hidden | Out-Null

$deadline = (Get-Date).AddSeconds(15)
do {
  Start-Sleep -Milliseconds 500
  if (Test-EyesHealth) {
    [pscustomobject]@{ status = 'VERIFIED'; endpoint = "http://127.0.0.1:$LocalPort"; transport = 'ssh-loopback-tunnel'; reused = $false } | ConvertTo-Json
    exit 0
  }
} while ((Get-Date) -lt $deadline)

throw 'Codexa AE Eyes tunnel did not become healthy'
