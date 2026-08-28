$ErrorActionPreference = 'Stop'

$port = 1337
$entry = 'C:\AtomEons\Orange5\06-ORANGELLM\server\index.mjs'
$workingDirectory = Split-Path -Parent $entry
$bun = (Get-Command bun -ErrorAction Stop).Source

$env:ORANGE5_VISUAL_ENABLED = '1'
$env:ORANGE5_CROSS_NODE_TRANSPORT = 'ae-phase'
$env:ORANGE5_AE_PHASE_URL = 'http://127.0.0.1:8907'
$env:ORANGE5_NAVIGATOR_MODEL = 'orange-navigator:ornith-1.5-9b-q4km'
$env:ORANGE5_NAVIGATOR_TRANSPORT = 'ollama'
if (-not $env:ORANGE5_NAVIGATOR_KEEP_ALIVE) { $env:ORANGE5_NAVIGATOR_KEEP_ALIVE = '15m' }
$env:ORANGE5_CODEXA_RAIL_URL = 'http://10.0.0.4:8097'
try {
    & 'C:\AtomEons\Orange5\scripts\ensure-codexa-ollama-tunnel.ps1' *> $null
    if ($null -ne (Invoke-RestMethod 'http://127.0.0.1:11437/api/tags' -TimeoutSec 5).models) {
        $env:ORANGE5_CODEXA_OLLAMA_URL = 'http://127.0.0.1:11437'
    }
} catch {
    Remove-Item Env:ORANGE5_CODEXA_OLLAMA_URL -ErrorAction SilentlyContinue
}
Remove-Item Env:ORANGE5_NAVIGATOR_URL -ErrorAction SilentlyContinue
# The former dedicated 4B Vulkan server is not an eligible primary Navigator.
# Compute-fabric selects the Ornith Ollama lease and leaves URL override unset.
if (-not $env:ORANGE5_CORTEX_MODEL) { $env:ORANGE5_CORTEX_MODEL = 'gemma4:e2b' }
if (-not $env:ORANGE5_CORTEX_OLLAMA_URL) { $env:ORANGE5_CORTEX_OLLAMA_URL = 'http://10.0.0.4:11434' }
if (-not $env:ORANGE5_CORTEX_FALLBACK_MODEL) { $env:ORANGE5_CORTEX_FALLBACK_MODEL = 'llava:7b' }
if (-not $env:ORANGE5_CORTEX_FALLBACK_URL) { $env:ORANGE5_CORTEX_FALLBACK_URL = 'http://127.0.0.1:11434' }
if (-not $env:QDRANT_URL) { $env:QDRANT_URL = 'http://127.0.0.1:6333' }
if (-not $env:OLLAMA_URL) { $env:OLLAMA_URL = 'http://127.0.0.1:11434' }
$env:AE_FLUX_ROOT = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-flux'

function Test-OrangeBrainHealth {
    try {
        $health = Invoke-RestMethod "http://127.0.0.1:$port/healthz" -TimeoutSec 5
        $navigator = $health.upstream.navigator
        return $health.service -eq 'orangellm-gateway' `
            -and $health.status -eq 'ok' `
            -and $navigator.live -eq $true `
            -and $navigator.model -eq $env:ORANGE5_NAVIGATOR_MODEL `
            -and $navigator.preferred_route -eq 'ae-phase' `
            -and $health.fabric.crossNodeTransport -eq 'ae-phase'
    } catch {
        return $false
    }
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1

if ($listener) {
    if (Test-OrangeBrainHealth) { exit 0 }
    throw "Port $port is listening but OrangeBrain health is invalid; refusing a duplicate launch."
}

try {
    Start-Process -FilePath $bun -ArgumentList @($entry) `
        -WorkingDirectory $workingDirectory -WindowStyle Hidden | Out-Null
} catch {
    throw "OrangeBrain launch failed: $($_.Exception.Message)"
}

$deadline = (Get-Date).AddSeconds(45)
do {
    if (Test-OrangeBrainHealth) { exit 0 }
    Start-Sleep -Milliseconds 400
} while ((Get-Date) -lt $deadline)
throw 'OrangeBrain process started but /healthz did not become ready within 45 seconds.'
