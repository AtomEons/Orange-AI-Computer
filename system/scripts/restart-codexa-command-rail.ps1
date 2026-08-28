param(
  [string]$Root = 'C:\AtomEons\ai-box',
  [int]$Port = 8097
)

$ErrorActionPreference = 'Stop'
$server = Join-Path $Root 'orangebox-command-rail\codexa-command-rail-server.mjs'
$workdir = Split-Path $server
$node = 'C:\Program Files\nodejs\node.exe'
$receiptRoot = Join-Path $Root 'receipts'

function Read-Secret {
  foreach ($name in @('ORANGEBOX_AI_BOX_COMMAND_TOKEN','ORANGEBOX_CODEXA_COMMAND_TOKEN')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    if ($value) { return $value }
  }
  foreach ($file in @('ORANGEBOX_AI_BOX_COMMAND_TOKEN.txt','ORANGEBOX_CODEXA_COMMAND_TOKEN.txt')) {
    $path = Join-Path $workdir $file
    if (Test-Path -LiteralPath $path) {
      $value = (Get-Content -LiteralPath $path -Raw).Trim()
      if ($value) { return $value }
    }
  }
  throw 'Codexa command-rail token is not configured.'
}

if (-not (Test-Path -LiteralPath $server)) { throw "Rail server missing: $server" }
if (-not (Test-Path -LiteralPath $node)) { throw "Node runtime missing: $node" }

$token = Read-Secret
$matches = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine.Contains('codexa-command-rail-server.mjs')
})
foreach ($process in $matches) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
}

$env:ORANGEBOX_AI_BOX_COMMAND_TOKEN = $token
$env:ORANGEBOX_AI_BOX_TRUSTED_IPS = '127.0.0.1,::1,10.0.99.2,10.0.99.0/24,10.0.0.0/24'
Start-Process -FilePath $node `
  -ArgumentList @($server,'--host','0.0.0.0','--port',"$Port",'--cockpitIp','10.0.99.2') `
  -WorkingDirectory $workdir `
  -WindowStyle Hidden | Out-Null

$health = $null
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  Start-Sleep -Milliseconds 500
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
    break
  } catch {}
}
if (-not $health) { throw "Codexa command rail did not become healthy on port $Port." }

New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$receipt = [ordered]@{
  schema = 'orangefive.codexa.rail-restart.v1'
  status = 'VERIFIED'
  checkedAt = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  port = $Port
  loopbackTunnelTrusted = $true
  tokenConfigured = [bool]$token
  stoppedProcesses = $matches.Count
  healthStatus = $health.status
}
$receiptPath = Join-Path $receiptRoot 'orangefive-codexa-rail-restart-latest.json'
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 6
