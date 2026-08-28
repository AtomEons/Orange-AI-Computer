[CmdletBinding()]
param(
  [string]$OllamaUrl = 'http://127.0.0.1:11434',
  [string]$Model = 'orange-navigator:ornith-1.5-9b-q4km'
)

$ErrorActionPreference = 'Stop'

# Compatibility entry point only. Navigator now uses Codexa Ollama with a
# bounded lease; this script verifies eligibility and never starts or pins it.
try {
  $inventory = Invoke-RestMethod "$($OllamaUrl.TrimEnd('/'))/api/tags" -TimeoutSec 5
} catch {
  throw "Codexa Ollama endpoint is unavailable at $OllamaUrl`: $($_.Exception.Message)"
}

$available = @($inventory.models | ForEach-Object { @($_.name, $_.model) }) -contains $Model
if (-not $available) {
  throw "Navigator model is not installed in Codexa Ollama: $Model"
}

$resident = $false
try {
  $running = Invoke-RestMethod "$($OllamaUrl.TrimEnd('/'))/api/ps" -TimeoutSec 5
  $resident = @($running.models | ForEach-Object { @($_.name, $_.model) }) -contains $Model
} catch {}

[pscustomobject]@{
  status = 'VERIFIED_AVAILABLE'
  endpoint = $OllamaUrl
  backend = 'ollama'
  model = $Model
  residencyPolicy = 'lease-on-demand'
  resident = $resident
  preload = $false
  compatibilityShim = 'retired-vulkan-entrypoint'
} | ConvertTo-Json -Depth 4
