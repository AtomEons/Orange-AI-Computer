param(
  [int]$GatewayPort = 1338,
  [int]$ProxyPort = 11435,
  [string]$CodexaTarget = "http://CODEXA.local:11434",
  [string]$HeavyModel = "qwen2.5-coder:32b"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$LogDir = Join-Path $Root "10-RECEIPTS\orange5-build\runtime-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*codexa-ollama-host-proxy.mjs*" -and $_.ProcessId -ne $PID } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$env:ORANGE5_CODEXA_PROXY_PORT = "$ProxyPort"
$env:ORANGE5_CODEXA_PROXY_TARGET = $CodexaTarget

Start-Process -FilePath "node.exe" `
  -ArgumentList @((Join-Path $PSScriptRoot "codexa-ollama-host-proxy.mjs")) `
  -WindowStyle Hidden `
  -WorkingDirectory $Root `
  -RedirectStandardOutput (Join-Path $LogDir "codexa-ollama-proxy.out.log") `
  -RedirectStandardError (Join-Path $LogDir "codexa-ollama-proxy.err.log") `
  -PassThru | Out-Null

Start-Sleep -Seconds 2
$proxyHealth = & curl.exe -sS "http://127.0.0.1:$ProxyPort/healthz"

$env:ORANGE5_DOCKER_GATEWAY_PORT = "$GatewayPort"
$env:ORANGE5_CODEXA_OLLAMA_URL = "http://host.docker.internal:$ProxyPort"
$env:ORANGE5_CODEXA_HEAVY_MODEL = $HeavyModel

docker compose -f (Join-Path $PSScriptRoot "docker-compose.yml") up -d

Start-Sleep -Seconds 4
$gatewayHealth = & curl.exe -sS "http://127.0.0.1:$GatewayPort/healthz"
$models = & curl.exe -sS "http://127.0.0.1:$GatewayPort/v1/models"

[ordered]@{
  ok = $true
  service = "orange5-n150-docker-runtime"
  gateway = "http://127.0.0.1:$GatewayPort"
  codexaProxy = "http://127.0.0.1:$ProxyPort"
  codexaTarget = $CodexaTarget
  heavyModel = $HeavyModel
  proxyHealth = $proxyHealth | ConvertFrom-Json
  gatewayHealth = $gatewayHealth | ConvertFrom-Json
  models = $models | ConvertFrom-Json
} | ConvertTo-Json -Depth 12
