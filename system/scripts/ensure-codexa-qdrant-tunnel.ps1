[CmdletBinding()]
param(
  [string]$CodexaHost = '10.0.0.4',
  [string]$CodexaUser = 'Atom',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519'),
  [int]$LocalPort = 6333,
  [int]$RemotePort = 6333
)

$ErrorActionPreference = 'Stop'
$knownHosts = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\codexa-vulkan-known-hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshBase = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$knownHosts")
$target = "$CodexaUser@$CodexaHost"

function Test-QdrantHealth {
  try {
    $health = Invoke-RestMethod "http://127.0.0.1:$LocalPort/" -TimeoutSec 3
    return [bool]$health.title -or [bool]$health.version
  } catch { return $false }
}

if (Test-QdrantHealth) {
  [pscustomobject]@{ status = 'VERIFIED'; endpoint = "http://127.0.0.1:$LocalPort"; transport = 'ssh-loopback-tunnel'; reused = $true } | ConvertTo-Json
  exit 0
}

$listeners = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue
if ($listeners) { throw "Local port $LocalPort is owned by a non-Qdrant process; refusing destructive replacement" }

& ssh @sshBase $target "curl.exe --silent --fail --max-time 5 http://127.0.0.1:$RemotePort/" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Codexa Qdrant is not healthy on remote loopback' }

$existing = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'ssh.exe' -and $_.CommandLine -match "127\.0\.0\.1:$LocalPort`:127\.0\.0\.1:$RemotePort"
}
$existing | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

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
  if (Test-QdrantHealth) {
    [pscustomobject]@{ status = 'VERIFIED'; endpoint = "http://127.0.0.1:$LocalPort"; transport = 'ssh-loopback-tunnel'; reused = $false } | ConvertTo-Json
    exit 0
  }
} while ((Get-Date) -lt $deadline)

throw 'Codexa Qdrant tunnel did not become healthy'
