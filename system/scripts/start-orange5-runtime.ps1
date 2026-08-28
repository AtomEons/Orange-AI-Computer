param([switch]$Once)

$ErrorActionPreference = 'Continue'
$root = 'C:\AtomEons\Orange5'
$atomSmasherRoot = Join-Path $env:USERPROFILE 'OrangeBox-Data\atomsmasher2-final-local'
$logDir = Join-Path $root '10-RECEIPTS\orange5-build\runtime-logs'
$log = Join-Path $logDir 'orange5-runtime-start.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# Canonical OrangeEye runtime wiring. Child processes inherit these values, so
# the gateway uses the same loopback-only topology after every reboot.
$env:ORANGE5_VISUAL_ENABLED = '1'
if (-not $env:ORANGE5_NAVIGATOR_MODEL) { $env:ORANGE5_NAVIGATOR_MODEL = 'orange-navigator:ornith-1.5-9b-q4km' }
$env:ORANGE5_NAVIGATOR_TRANSPORT = 'ollama'
if (-not $env:ORANGE5_NAVIGATOR_KEEP_ALIVE) { $env:ORANGE5_NAVIGATOR_KEEP_ALIVE = '15m' }
if (-not $env:ORANGE5_CORTEX_MODEL) { $env:ORANGE5_CORTEX_MODEL = 'gemma4:e2b' }
if (-not $env:ORANGE5_CORTEX_FALLBACK_MODEL) { $env:ORANGE5_CORTEX_FALLBACK_MODEL = 'llava:7b' }
if (-not $env:ORANGE5_CORTEX_FALLBACK_URL) { $env:ORANGE5_CORTEX_FALLBACK_URL = 'http://127.0.0.1:11434' }
if (-not $env:QDRANT_URL) { $env:QDRANT_URL = 'http://127.0.0.1:6333' }
if (-not $env:OLLAMA_URL) { $env:OLLAMA_URL = 'http://127.0.0.1:11434' }
$env:AE_FLUX_ROOT = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-flux'

function Log([string]$Message) {
  "[$((Get-Date).ToUniversalTime().ToString('o'))] $Message" | Add-Content -LiteralPath $log
}

function Test-HttpOk([string]$Url, [int]$TimeoutSec = 5) {
  try {
    $code = & curl.exe --noproxy '*' --silent --show-error --output NUL `
      --write-out '%{http_code}' --max-time $TimeoutSec $Url 2>$null
    return [int]$code -ge 200 -and [int]$code -lt 300
  } catch {
    return $false
  }
}

function Test-OllamaModelAvailable([string]$BaseUrl, [string]$Model) {
  try {
    $tags = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/api/tags" -TimeoutSec 8
    $wanted = $Model -replace ':latest$', ''
    return @($tags.models | ForEach-Object { ($_.name -replace ':latest$', '') }) -contains $wanted
  } catch {
    Log "Navigator inventory probe failed: $($_.Exception.Message)"
    return $false
  }
}

function Update-ComputeFabric {
  try {
    $raw = (& bun (Join-Path $root '03-BACKEND\compute-fabric-cli.mjs') discover --no-neighbors 2>$null) -join "`n"
    $state = $raw | ConvertFrom-Json
    if ($state.selections.navigator -and $state.selections.navigator.kind -eq 'openai') {
      $env:ORANGE5_NAVIGATOR_URL = $state.selections.navigator.url
    } elseif ($state.selections.navigator -and $state.selections.navigator.kind -eq 'ollama') {
      Remove-Item Env:ORANGE5_NAVIGATOR_URL -ErrorAction SilentlyContinue
    }
    if ($state.selections.rail) { $env:ORANGE5_CODEXA_RAIL_URL = $state.selections.rail.url }
    if (-not $env:ORANGE5_CORTEX_OLLAMA_URL -and $state.selections.inference) {
      $env:ORANGE5_CORTEX_OLLAMA_URL = $state.selections.inference.url
    }
    Log "Compute fabric status=$($state.status) mode=$($state.mode) navigator=$($state.selections.navigator.url) rail=$($state.selections.rail.url)"
    return $state
  } catch {
    Log "Compute fabric discovery failed: $($_.Exception.Message)"
    return $null
  }
}

function Ensure-ProcessEndpoint {
  param(
    [string]$Name,
    [string]$HealthUrl,
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory = $root,
    [int]$WaitSeconds = 8
  )

  if (Test-HttpOk -Url $HealthUrl) {
    Log "$Name already healthy at $HealthUrl"
    return $true
  }

  # A listener with a failed health probe is degraded, not absent. Never spawn
  # a duplicate on top of a process that already owns the service port.
  try {
    $portMatch = [regex]::Match($HealthUrl, ':(\d+)')
    if ($portMatch.Success) {
      $port = [int]$portMatch.Groups[1].Value
      if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        Log "$Name is listening on $port but health failed; duplicate start suppressed"
        return $false
      }
    }
  } catch {}

  Log "Starting $Name"
  try {
    Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
      -WorkingDirectory $WorkingDirectory -WindowStyle Hidden | Out-Null
  } catch {
    Log "Failed to start ${Name}: $($_.Exception.Message)"
    return $false
  }

  Start-Sleep -Seconds $WaitSeconds
  $ok = Test-HttpOk -Url $HealthUrl -TimeoutSec 10
  Log "$Name health after start: $ok"
  return $ok
}

function Ensure-QdrantVisionCollection {
  if (-not (Test-HttpOk -Url 'http://127.0.0.1:6333/' -TimeoutSec 8)) {
    Log 'Qdrant is not reachable on 127.0.0.1:6333'
    return $false
  }
  try {
    & bun (Join-Path $root '07-VISUAL\qdrant\init-collection.mjs') *> $null
    $ok = Test-HttpOk -Url 'http://127.0.0.1:6333/collections/orange5-vision' -TimeoutSec 8
    Log "Qdrant orange5-vision collection ready: $ok"
    return $ok
  } catch {
    Log "Qdrant orange5-vision initialization failed: $($_.Exception.Message)"
    return $false
  }
}

function Ensure-CodexaNavigatorWarm {
  param([string]$Model = 'orange-navigator:ornith-1.5-9b-q4km')
  $baseUrl = if ($env:ORANGE5_CODEXA_OLLAMA_URL) { $env:ORANGE5_CODEXA_OLLAMA_URL } else { 'http://10.0.0.4:11434' }
  $base = $baseUrl.TrimEnd('/')
  try {
    $running = Invoke-RestMethod -Uri "$base/api/ps" -TimeoutSec 8
    if ($running.models.name -contains $Model) {
      Log "Codexa Navigator already resident: $Model"
      return $true
    }
    $body = @{ model = $Model; keep_alive = $env:ORANGE5_NAVIGATOR_KEEP_ALIVE } | ConvertTo-Json -Compress
    $loaded = Invoke-RestMethod -Method Post -Uri "$base/api/generate" -ContentType 'application/json' -Body $body -TimeoutSec 120
    $running = Invoke-RestMethod -Uri "$base/api/ps" -TimeoutSec 8
    $ok = $running.models.name -contains $Model
    Log "Codexa Navigator preload model=$Model done=$($loaded.done) resident=$ok"
    return $ok
  } catch {
    Log "Codexa Navigator preload failed: $($_.Exception.Message)"
    return $false
  }
}

$vulkanNavigatorOk = $false
Remove-Item Env:ORANGE5_NAVIGATOR_URL -ErrorAction SilentlyContinue

Log "OrangeFive runtime ensure started. Once=$Once"

$ollamaOk = Ensure-ProcessEndpoint -Name 'Ollama' `
  -HealthUrl 'http://127.0.0.1:11434/api/tags' `
  -FilePath (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe') `
  -ArgumentList @('serve')

try {
  & (Join-Path $root 'scripts\ensure-codexa-ollama-tunnel.ps1') *> $null
  if (Test-HttpOk -Url 'http://127.0.0.1:11437/api/tags' -TimeoutSec 5) {
    $env:ORANGE5_CODEXA_OLLAMA_URL = 'http://127.0.0.1:11437'
  }
} catch {
  Remove-Item Env:ORANGE5_CODEXA_OLLAMA_URL -ErrorAction SilentlyContinue
  Log "Codexa Ollama tunnel setup failed: $($_.Exception.Message)"
}
# Do not revive the retired 4B Vulkan bridge. Navigator is an Ollama lease on
# Codexa and compute-fabric must select the requested Ornith model explicitly.
try {
  & (Join-Path $root 'scripts\ensure-codexa-qdrant-tunnel.ps1') *> $null
} catch {
  Log "Codexa Qdrant tunnel setup failed: $($_.Exception.Message)"
}
$qdrantOk = Ensure-QdrantVisionCollection
$fabricState = Update-ComputeFabric
$navigatorBaseUrl = if ($env:ORANGE5_CODEXA_OLLAMA_URL) { $env:ORANGE5_CODEXA_OLLAMA_URL } else { 'http://10.0.0.4:11434' }
$navigatorAvailable = Test-OllamaModelAvailable -BaseUrl $navigatorBaseUrl -Model $env:ORANGE5_NAVIGATOR_MODEL
Log "Navigator lease target available=$navigatorAvailable model=$env:ORANGE5_NAVIGATOR_MODEL"

$navigatorKernelOk = Test-Path -LiteralPath (Join-Path $root '03-BACKEND\navigator-kernel.mjs')
Log "Navigator Kernel ready (zero resident model): $navigatorKernelOk"
$navigatorWarm = $null
$navigatorRuntimeOk = $navigatorAvailable
if ($env:ORANGE5_PRELOAD_NAVIGATOR -eq '1') {
  $navigatorWarm = Ensure-CodexaNavigatorWarm -Model $env:ORANGE5_NAVIGATOR_MODEL
  $navigatorRuntimeOk = $navigatorAvailable -and $navigatorWarm
} else {
  Log 'Navigator model residency is leased on demand; boot preload skipped.'
}

$gatewayOk = Ensure-ProcessEndpoint -Name 'OrangeBrain gateway' `
  -HealthUrl 'http://127.0.0.1:1337/healthz' `
  -FilePath 'bun' `
  -ArgumentList @((Join-Path $root '06-ORANGELLM\server\index.mjs')) `
  -WaitSeconds 5
if ($gatewayOk) {
  try {
    $gatewayHealth = Invoke-RestMethod 'http://127.0.0.1:1337/healthz' -TimeoutSec 8
    $gatewayNavigator = $gatewayHealth.upstream.navigator
    $gatewayOk = $gatewayHealth.service -eq 'orangellm-gateway' `
      -and $gatewayHealth.status -eq 'ok' `
      -and $gatewayNavigator.live -eq $true `
      -and $gatewayNavigator.model -eq $env:ORANGE5_NAVIGATOR_MODEL `
      -and $gatewayNavigator.preferred_route -eq 'direct_ollama'
    Log "OrangeBrain routed Navigator health: $gatewayOk model=$($gatewayNavigator.model) route=$($gatewayNavigator.preferred_route)"
  } catch {
    $gatewayOk = $false
    Log "OrangeBrain routed Navigator probe failed: $($_.Exception.Message)"
  }
}

$cobraOk = Ensure-ProcessEndpoint -Name 'AE Cobra memory' `
  -HealthUrl 'http://127.0.0.1:7419/healthz' `
  -FilePath 'bun' `
  -ArgumentList @((Join-Path $root '06-ORANGELLM\memory\ae-cobra\flow-direct\server.mjs')) `
  -WorkingDirectory (Join-Path $root '06-ORANGELLM\memory\ae-cobra') `
  -WaitSeconds 5

$hermesOk = Ensure-ProcessEndpoint -Name 'Hermes governed agent runtime' `
  -HealthUrl 'http://127.0.0.1:7430/healthz' `
  -FilePath 'bun' `
  -ArgumentList @((Join-Path $root '08-HERMES\src\server.mjs')) `
  -WorkingDirectory (Join-Path $root '08-HERMES') `
  -WaitSeconds 5

$atomSmasherOk = Ensure-ProcessEndpoint -Name 'AtomSmasher 2' `
  -HealthUrl 'http://127.0.0.1:8901/health' `
  -FilePath 'bun' `
  -ArgumentList @((Join-Path $atomSmasherRoot 'start-daemon.mjs')) `
  -WorkingDirectory $atomSmasherRoot `
  -WaitSeconds 5

try {
  & (Join-Path $root '07-VISUAL\colpali-service\start-n150-proxy.ps1')
  $eyesOk = Test-HttpOk -Url 'http://127.0.0.1:7440/health' -TimeoutSec 10
  Log "AE Eyes facade health: $eyesOk"
} catch {
  $eyesOk = $false
  Log "AE Eyes facade start failed: $($_.Exception.Message)"
}
$fabricState = Update-ComputeFabric

try {
  & (Join-Path $root '06-ORANGELLM\memory\ae-cobra\start-mirror-daemon.ps1')
  Start-Sleep -Milliseconds 500
  $mirrorStatusPath = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-mirror-daemon-status.json'
  $mirrorState = if (Test-Path -LiteralPath $mirrorStatusPath) {
    (Get-Content -LiteralPath $mirrorStatusPath -Raw | ConvertFrom-Json).state
  } else { 'missing' }
  $mirrorOk = $mirrorState -eq 'healthy'
  Log "AE Cobra mirror state: $mirrorState"
} catch {
  $mirrorOk = $false
  $mirrorState = 'error'
  Log "AE Cobra mirror start failed: $($_.Exception.Message)"
}

$allOrgans = @($ollamaOk, $qdrantOk, $navigatorKernelOk, $navigatorRuntimeOk, $gatewayOk, $cobraOk, $hermesOk, $atomSmasherOk, $eyesOk, $mirrorOk)
$status = if ($allOrgans -notcontains $false) { 'ORANGE5_RUNTIME_GREEN' } else { 'ORANGE5_RUNTIME_NEEDS_ATTENTION' }
$receipt = [ordered]@{
  schema = 'orange.receipt.runtime_start.v3'
  status = $status
  timestamp_utc = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  ollama_ok = $ollamaOk
  qdrant_vision_ok = $qdrantOk
  navigator_kernel_ok = $navigatorKernelOk
  codexa_navigator_model = $env:ORANGE5_NAVIGATOR_MODEL
  codexa_navigator_available = $navigatorAvailable
  codexa_navigator_warm = $navigatorWarm
  navigator_residency_policy = 'leased_on_demand'
  codexa_navigator_vulkan = $vulkanNavigatorOk
  compute_fabric_status = $fabricState.status
  compute_fabric_mode = $fabricState.mode
  compute_fabric_sha256 = $fabricState.sha256
  n150_answer_model_required = $false
  orangebrain_gateway_ok = $gatewayOk
  ae_cobra_ok = $cobraOk
  hermes_ok = $hermesOk
  atomsmasher_ok = $atomSmasherOk
  ae_eyes_facade_ok = $eyesOk
  cobra_mirror_ok = $mirrorOk
  cobra_mirror_state = $mirrorState
  endpoints = [ordered]@{
    ollama = 'http://127.0.0.1:11434/api/tags'
    qdrant_vision = 'http://127.0.0.1:6333/collections/orange5-vision'
    navigator_kernel = 'http://127.0.0.1:1337/v1/models'
    orangebrain_gateway = 'http://127.0.0.1:1337/healthz'
    ae_cobra = 'http://127.0.0.1:7419/healthz'
    hermes = 'http://127.0.0.1:7430/healthz'
    atomsmasher = 'http://127.0.0.1:8901/health'
    ae_eyes_facade = 'http://127.0.0.1:7440/health'
  }
  log = $log
}

$receiptPath = Join-Path $logDir 'orange5-runtime-start-latest.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
Log "Receipt written: $receiptPath status=$status"

if (-not $Once) { exit $(if ($status -eq 'ORANGE5_RUNTIME_GREEN') { 0 } else { 1 }) }
