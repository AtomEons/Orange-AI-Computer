[CmdletBinding()]
param(
  [string]$CodexaHost = '10.0.0.4',
  [string]$CodexaUser = 'Atom',
  [string]$KeyPath = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519'),
  [int]$LocalPort = 11437,
  [int]$RemotePort = 11434,
  [string]$Model = 'orange-navigator:ornith-1.5-9b-q4km'
)

$ErrorActionPreference = 'Stop'
$knownHosts = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\codexa-ollama-known-hosts'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $knownHosts) | Out-Null
$sshBase = @('-i', $KeyPath, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', "UserKnownHostsFile=$knownHosts")
$target = "$CodexaUser@$CodexaHost"
$endpoint = "http://127.0.0.1:$LocalPort"

function Get-NavigatorInventory {
  try { return Invoke-RestMethod "$endpoint/api/tags" -TimeoutSec 5 }
  catch { return $null }
}

# Retired-name compatibility shim. The old Vulkan server is not eligible for
# OrangeFive routing; this only establishes the independent Ollama tunnel.
$inventory = Get-NavigatorInventory
if ($null -eq $inventory) {
  $listeners = Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue
  if ($listeners) { throw "Local port $LocalPort is owned by a non-Ollama process; refusing destructive replacement" }

  & ssh @sshBase $target "curl.exe --silent --fail --max-time 5 http://127.0.0.1:$RemotePort/api/tags" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Codexa Ollama is not healthy on remote loopback' }

  $tunnelArgs = @('-N') + $sshBase + @(
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', "127.0.0.1:$LocalPort`:127.0.0.1:$RemotePort",
    $target
  )
  Start-Process ssh.exe -ArgumentList $tunnelArgs -WindowStyle Hidden | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 500
    $inventory = Get-NavigatorInventory
  } while ($null -eq $inventory -and (Get-Date) -lt $deadline)
}

if ($null -eq $inventory) {
  throw 'Codexa Ollama tunnel did not pass its endpoint probe'
}

$available = @($inventory.models | ForEach-Object { @($_.name, $_.model) }) -contains $Model
if (-not $available) {
  throw "Navigator model is not installed behind the Codexa Ollama tunnel: $Model"
}

[pscustomobject]@{
  status = 'VERIFIED_AVAILABLE'
  endpoint = $endpoint
  backend = 'ollama'
  transport = 'ssh-loopback-tunnel'
  model = $Model
  residencyPolicy = 'lease-on-demand'
  preload = $false
  compatibilityShim = 'retired-vulkan-entrypoint'
} | ConvertTo-Json -Depth 4
