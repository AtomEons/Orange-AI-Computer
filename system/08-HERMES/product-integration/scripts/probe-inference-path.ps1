[CmdletBinding()]
param(
  [string]$ModelUrl = 'http://127.0.0.1:11337/v1',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$OllamaModel = 'orange-navigator:ornith-1.5-9b-q4km',
  [string]$GatewayModel = 'orange-navigator',
  [switch]$OllamaOnly,
  [switch]$SkipOllama,
  [switch]$SkipHermes,
  [int]$TimeoutSec = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Nonce = "HERMES_PATH_$([Guid]::NewGuid().ToString('N').Substring(0, 12).ToUpperInvariant())"

function Invoke-Probe([string]$Name, [string]$Uri, [hashtable]$Headers, [hashtable]$Body) {
  $started = Get-Date
  try {
    $response = Invoke-RestMethod -Uri $Uri -Method Post -Headers $Headers -Body ($Body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec $TimeoutSec
    $content = [string]$response.choices[0].message.content
    $validOrangeReport = $false
    try {
      $compiled = $content | ConvertFrom-Json
      $validOrangeReport = $compiled.schema -eq 'orange.report.v1' -and
        -not [string]::IsNullOrWhiteSpace([string]$compiled.orderId) -and
        -not [string]::IsNullOrWhiteSpace([string]$compiled.status) -and
        $null -ne $compiled.actionsTaken -and $null -ne $compiled.evidence -and
        $null -ne $compiled.blockers -and -not [string]::IsNullOrWhiteSpace([string]$compiled.nextAction)
    } catch { $validOrangeReport = $false }
    $containsNonce = $content -match [regex]::Escape($Nonce)
    return [ordered]@{
      name = $Name
      status = if ($containsNonce -or $validOrangeReport) { 'PASS' } else { 'FAIL' }
      latencyMs = [int]((Get-Date) - $started).TotalMilliseconds
      model = [string]$response.model
      exactNonce = $content.Trim() -eq $Nonce
      containsNonce = $containsNonce
      validOrangeReport = $validOrangeReport
      contentLength = $content.Length
      contentPreview = $content.Substring(0, [Math]::Min(500, $content.Length))
    }
  } catch {
    return [ordered]@{
      name = $Name
      status = 'FAIL'
      latencyMs = [int]((Get-Date) - $started).TotalMilliseconds
      error = $_.Exception.Message
    }
  }
}

function Invoke-OllamaProbe([string]$Uri) {
  $started = Get-Date
  try {
    $body = @{
      model = $OllamaModel
      messages = @(@{ role = 'user'; content = "Reply with exactly $Nonce and nothing else." })
      stream = $false
      think = $false
      keep_alive = '10m'
      options = @{ temperature = 0; num_predict = 128; num_ctx = 8192 }
    }
    $response = Invoke-RestMethod -Uri $Uri -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Depth 8 -Compress) -TimeoutSec $TimeoutSec
    $content = [string]$response.message.content
    return [ordered]@{
      name = 'ollama-direct'
      status = if ($content -match [regex]::Escape($Nonce)) { 'PASS' } else { 'FAIL' }
      latencyMs = [int]((Get-Date) - $started).TotalMilliseconds
      model = [string]$response.model
      exactNonce = $content.Trim() -eq $Nonce
      containsNonce = $content -match [regex]::Escape($Nonce)
      contentLength = $content.Length
      contentPreview = $content.Substring(0, [Math]::Min(500, $content.Length))
    }
  } catch {
    return [ordered]@{ name = 'ollama-direct'; status = 'FAIL'; latencyMs = [int]((Get-Date) - $started).TotalMilliseconds; error = $_.Exception.Message }
  }
}

$common = @{
  model = $GatewayModel
  messages = @(@{ role = 'user'; content = "Reply with exactly $Nonce and nothing else." })
  max_tokens = 48
  temperature = 0
  stream = $false
}
$ollama = if ($SkipOllama) { $null } else { Invoke-OllamaProbe 'http://127.0.0.1:11434/api/chat' }
$results = @($ollama | Where-Object { $_ })
if ($OllamaOnly) {
  [ordered]@{
    schema = 'orange5.hermes-inference-path.v1'
    createdAt = (Get-Date).ToUniversalTime().ToString('o')
    status = $ollama.status
    probes = $results
  } | ConvertTo-Json -Depth 10
  exit $(if ($ollama.status -eq 'PASS') { 0 } else { 1 })
}
$direct = Invoke-Probe 'orange-model-gateway' "$($ModelUrl.TrimEnd('/'))/chat/completions" @{ 'Content-Type' = 'application/json' } $common

$profileEnv = Join-Path $DataRoot '.hermes\profiles\navigator\.env'
$keyLine = Get-Content -LiteralPath $profileEnv | Where-Object { $_ -match '^API_SERVER_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw "Navigator API key is missing: $profileEnv" }
$apiKey = $keyLine.Split('=', 2)[1]
$hermesHeaders = @{
  Authorization = "Bearer $apiKey"
  'Content-Type' = 'application/json'
  'X-Hermes-Session-Id' = "path-$([Guid]::NewGuid().ToString('N'))"
  'X-Hermes-Session-Key' = 'orange5-hermes-path-proof'
}
$hermes = if ($SkipHermes) { $null } else { Invoke-Probe 'hermes-navigator' 'http://127.0.0.1:8642/p/navigator/v1/chat/completions' $hermesHeaders $common }

[ordered]@{
  schema = 'orange5.hermes-inference-path.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  status = if (($SkipOllama -or $ollama.status -eq 'PASS') -and $direct.status -eq 'PASS' -and ($SkipHermes -or $hermes.status -eq 'PASS')) { 'PASS' } else { 'FAIL' }
  probes = @($ollama, $direct, $hermes | Where-Object { $_ })
} | ConvertTo-Json -Depth 10
