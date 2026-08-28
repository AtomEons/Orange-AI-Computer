[CmdletBinding()]
param([string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$HermesHome = Join-Path $DataRoot '.hermes'
$Profiles = @('navigator', 'builder', 'researcher', 'reviewer', 'visual', 'misfit')

function Read-Key([string]$Path) {
  $line = Get-Content -LiteralPath $Path | Where-Object { $_ -match '^API_SERVER_KEY=' } | Select-Object -First 1
  if (-not $line) { throw "API key is missing: $Path" }
  return $line.Split('=', 2)[1]
}

function Get-Surface([string]$Name, [string]$Uri, [string]$Key) {
  try {
    $response = Invoke-RestMethod -Uri $Uri -Headers @{ Authorization = "Bearer $Key" } -TimeoutSec 20
    $enabled = @($response.data | Where-Object { $_.enabled -eq $true } | ForEach-Object {
      [ordered]@{ name = $_.name; tools = @($_.tools) }
    })
    return [ordered]@{ name = $Name; status = 'PASS'; uri = $Uri; enabled = $enabled }
  } catch {
    return [ordered]@{ name = $Name; status = 'FAIL'; uri = $Uri; error = $_.Exception.Message; enabled = @() }
  }
}

$surfaces = @()
$ownerKey = Read-Key (Join-Path $HermesHome '.env')
$surfaces += Get-Surface 'owner' 'http://127.0.0.1:8642/v1/toolsets' $ownerKey
foreach ($profile in $Profiles) {
  $key = Read-Key (Join-Path $HermesHome "profiles\$profile\.env")
  $surfaces += Get-Surface $profile "http://127.0.0.1:8642/p/$profile/v1/toolsets" $key
}

[ordered]@{
  schema = 'orange5.hermes-loaded-surfaces.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  note = 'Hermes /v1/toolsets intentionally omits MCP servers; this reports enabled native toolsets only.'
  surfaces = $surfaces
} | ConvertTo-Json -Depth 12
