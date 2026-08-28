param(
  [ValidateSet('boot','logon','manual')][string]$Mode = 'manual',
  [string]$OllamaHost = '0.0.0.0:11434'
)

$ErrorActionPreference = 'Continue'
$root = 'C:\AtomEons\ai-box'
$orangeRoot = 'C:\AtomEons\Orange5'
$receiptRoot = Join-Path $root 'receipts'
$logRoot = Join-Path $root 'logs'
$receiptPath = Join-Path $receiptRoot 'orangefive-codexa-runtime-latest.json'
$node = 'C:\Program Files\nodejs\node.exe'
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$docker = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
New-Item -ItemType Directory -Force -Path $receiptRoot,$logRoot | Out-Null

function Probe([string]$Url, [int]$TimeoutSec = 4) {
  try {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Proxy = $null
    $request.Timeout = $TimeoutSec * 1000
    $response = $request.GetResponse()
    try { $code = [int]$response.StatusCode } finally { $response.Close() }
    return [ordered]@{ url=$Url; ok=($code -ge 200 -and $code -lt 300); code=$code }
  } catch { return [ordered]@{ url=$Url; ok=$false; code=0; error=$_.Exception.Message } }
}

function Wait-Probe([string]$Url, [int]$Seconds) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do {
    $p = Probe $Url 3
    if ($p.ok) { return $p }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return Probe $Url 5
}

function Read-Secret([string[]]$Paths, [string[]]$EnvironmentNames) {
  foreach ($name in $EnvironmentNames) {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Machine') }
    if ($value) { return $value }
  }
  foreach ($path in $Paths) {
    if (Test-Path -LiteralPath $path) {
      $value = (Get-Content -LiteralPath $path -Raw).Trim()
      if ($value) { return $value }
    }
  }
  return $null
}

function Start-Hidden([string]$Name, [string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
  try {
    if ($Arguments.Count -gt 0) {
      Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
    } else {
      Start-Process -FilePath $File -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
    }
    return [ordered]@{ name=$Name; started=$true }
  } catch { return [ordered]@{ name=$Name; started=$false; error=$_.Exception.Message } }
}

if ($Mode -eq 'boot') { Start-Sleep -Seconds 15 }
$starts = @()

$ollamaProbe = Probe 'http://127.0.0.1:11434/api/tags' 3
if (-not $ollamaProbe.ok -and (Test-Path $ollama)) {
  # Codexa is OrangeFive's heavy inference host. Bind directly to the AE
  # networks instead of depending on a fragile Windows port-proxy hop.
  $env:OLLAMA_HOST = $OllamaHost
  $starts += Start-Hidden 'ollama' $ollama @('serve') (Split-Path $ollama)
}
$ollamaProbe = Wait-Probe 'http://127.0.0.1:11434/api/tags' 60

$knowledgeProbe = Probe 'http://127.0.0.1:8099/' 3
if (-not $knowledgeProbe.ok) {
  Start-Service -Name 'com.docker.service' -ErrorAction SilentlyContinue
  if (Test-Path $docker) { $starts += Start-Hidden 'docker-desktop' $docker @('-Autostart') (Split-Path $docker) }
}

$railToken = Read-Secret `
  @((Join-Path $root 'orangebox-command-rail\ORANGEBOX_AI_BOX_COMMAND_TOKEN.txt'), (Join-Path $root 'orangebox-command-rail\ORANGEBOX_CODEXA_COMMAND_TOKEN.txt')) `
  @('ORANGEBOX_AI_BOX_COMMAND_TOKEN','ORANGEBOX_CODEXA_COMMAND_TOKEN')
$railProbe = Probe 'http://127.0.0.1:8097/health' 3
if (-not $railProbe.ok -and $railToken) {
  $env:ORANGEBOX_AI_BOX_COMMAND_TOKEN = $railToken
  # SSH local-forward traffic reaches the Codexa rail from loopback. Trusting
  # loopback preserves the private tunnel without opening the rail publicly.
  $env:ORANGEBOX_AI_BOX_TRUSTED_IPS = '127.0.0.1,::1,10.0.99.2,10.0.99.0/24,10.0.0.0/24'
  $starts += Start-Hidden 'command-rail' $node `
    @((Join-Path $root 'orangebox-command-rail\codexa-command-rail-server.mjs'),'--host','0.0.0.0','--port','8097','--cockpitIp','10.0.99.2') `
    (Join-Path $root 'orangebox-command-rail')
}
$railProbe = Wait-Probe 'http://127.0.0.1:8097/health' 30

$bridgeToken = Read-Secret @((Join-Path $root 'orangebox-bridge\ORANGEBOX_BRIDGE_TOKEN.txt')) @('ORANGEBOX_BRIDGE_TOKEN')
$bridgeProbe = Probe 'http://127.0.0.1:8098/health' 3
if (-not $bridgeProbe.ok -and $bridgeToken) {
  $env:ORANGEBOX_BRIDGE_TOKEN = $bridgeToken
  $starts += Start-Hidden 'receipt-bridge' $node `
    @((Join-Path $root 'orangebox-bridge\codexa-bridge-server.mjs'),'--host','0.0.0.0','--port','8098') `
    (Join-Path $root 'orangebox-bridge')
}
$bridgeProbe = Wait-Probe 'http://127.0.0.1:8098/health' 30
$knowledgeProbe = Wait-Probe 'http://127.0.0.1:8099/' 90

$openWebUiPrivate = Probe 'http://10.0.99.1:8080/health' 3
$n8nPrivate = Probe 'http://10.0.99.1:5678/healthz' 3
if (-not $openWebUiPrivate.ok -or -not $n8nPrivate.ok) {
  $privateLinkScript = Join-Path $root 'orangefive-runtime\codexa-private-link-proxy.ps1'
  if (Test-Path $privateLinkScript) {
    $starts += Start-Hidden 'private-link-services' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$privateLinkScript) (Split-Path $privateLinkScript)
  }
}
$openWebUiPrivate = Wait-Probe 'http://10.0.99.1:8080/health' 20
$n8nPrivate = Wait-Probe 'http://10.0.99.1:5678/healthz' 20

$eyesProbe = Probe 'http://127.0.0.1:7440/health' 3
if (-not $eyesProbe.ok) {
  $eyesScript = Join-Path $orangeRoot '07-VISUAL\colpali-service\start-codexa.ps1'
  if (Test-Path $eyesScript) { $starts += Start-Hidden 'ae-eyes' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$eyesScript) (Split-Path $eyesScript) }
}
$eyesProbe = Wait-Probe 'http://127.0.0.1:7440/health' 60

$atomProbe = Probe 'http://127.0.0.1:8901/health' 3
if (-not $atomProbe.ok) {
  $atomScript = Join-Path $root 'orangefive-runtime\codexa-atomsmasher-daemon.ps1'
  if (Test-Path $atomScript) { $starts += Start-Hidden 'atomsmasher2' 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File',$atomScript) (Split-Path $atomScript) }
}
$atomProbe = Wait-Probe 'http://127.0.0.1:8901/health' 30

$requiredModels = @('orange-navigator:latest','qwen3-coder:30b','qwen3:30b-a3b','dolphin3:8b')
$installedModels = @()
try { $installedModels = @((Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10).models.name) } catch {}
$missingModels = @($requiredModels | Where-Object { $_ -notin $installedModels })

$endpoints = [ordered]@{
  ollama=$ollamaProbe
  commandRail=$railProbe
  receiptBridge=$bridgeProbe
  knowledge=$knowledgeProbe
  openWebUiPrivate=$openWebUiPrivate
  n8nPrivate=$n8nPrivate
  aeEyes=$eyesProbe
  atomSmasher=$atomProbe
}
$ok = @($endpoints.Values | ForEach-Object { $_.ok }) -notcontains $false
$ok = $ok -and $missingModels.Count -eq 0 -and [bool]$railToken -and [bool]$bridgeToken
$receipt = [ordered]@{
  schema='orangefive.codexa.runtime.v1'
  status=$(if($ok){'ORANGEFIVE_CODEXA_GREEN'}else{'ORANGEFIVE_CODEXA_NEEDS_ATTENTION'})
  checkedAt=(Get-Date).ToUniversalTime().ToString('o')
  mode=$Mode
  host=$env:COMPUTERNAME
  endpoints=$endpoints
  requiredModels=$requiredModels
  installedModelCount=$installedModels.Count
  missingModels=$missingModels
  secrets=[ordered]@{ commandRailConfigured=[bool]$railToken; bridgeConfigured=[bool]$bridgeToken; exposedInCommandLine=$false }
  starts=$starts
}
$receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8
$receipt | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $receiptRoot ("orangefive-codexa-runtime-{0:yyyyMMdd-HHmmss}.json" -f (Get-Date))) -Encoding utf8
if (-not $ok) { exit 1 }
