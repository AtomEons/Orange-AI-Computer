param(
  [ValidateSet('Apply', 'Rollback', 'Status')]
  [string]$Mode = 'Status',
  [string]$AdapterName = 'Ethereal-Link',
  [string]$DataRoot = (Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5')
)

$ErrorActionPreference = 'Stop'
$baselinePath = Join-Path $DataRoot 'topology\ae-pulse-link-baseline.json'
$desired = [ordered]@{
  'Energy-Efficient Ethernet' = 'Disabled'
  'Energy Efficient Ethernet' = 'Disabled'
  'Green Ethernet' = 'Disabled'
  'Power Saving Mode' = 'Disabled'
  'Interrupt Moderation' = 'Disabled'
  'Interrupt Moderation Rate' = 'Off'
}

function Get-LinkState {
  $adapter = Get-NetAdapter -Name $AdapterName -ErrorAction Stop
  $properties = Get-NetAdapterAdvancedProperty -Name $AdapterName -ErrorAction Stop |
    Where-Object { $desired.Contains($_.DisplayName) -or $_.DisplayName -in @('Receive Side Scaling', 'Maximum Number of RSS Queues', 'Speed & Duplex', 'Jumbo Frame', 'Jumbo Packet', 'Flow Control') } |
    Select-Object DisplayName, DisplayValue, RegistryKeyword, RegistryValue, ValidDisplayValues
  [pscustomobject]@{
    capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    adapter = $adapter | Select-Object Name, InterfaceDescription, Status, LinkSpeed, MacAddress
    properties = @($properties)
  }
}

if ($Mode -eq 'Status') {
  Get-LinkState | ConvertTo-Json -Depth 8
  exit 0
}

if ($Mode -eq 'Rollback') {
  if (-not (Test-Path -LiteralPath $baselinePath)) { throw "AE Pulse link baseline not found: $baselinePath" }
  $baseline = Get-Content -LiteralPath $baselinePath -Raw | ConvertFrom-Json
  foreach ($property in $baseline.properties) {
    $current = Get-NetAdapterAdvancedProperty -Name $AdapterName -DisplayName $property.DisplayName -ErrorAction SilentlyContinue
    if ($current -and $current.ValidDisplayValues -contains $property.DisplayValue -and $current.DisplayValue -ne $property.DisplayValue) {
      Set-NetAdapterAdvancedProperty -Name $AdapterName -DisplayName $property.DisplayName -DisplayValue $property.DisplayValue -NoRestart
    }
  }
  Restart-NetAdapter -Name $AdapterName -Confirm:$false
  [pscustomobject]@{schema='orange.ae-pulse.link-tuning.v1';ok=$true;mode='Rollback';baselinePath=$baselinePath;state=(Get-LinkState)} | ConvertTo-Json -Depth 10
  exit 0
}

$before = Get-LinkState
if (-not (Test-Path -LiteralPath $baselinePath)) {
  New-Item -ItemType Directory -Path (Split-Path $baselinePath) -Force | Out-Null
  $before | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $baselinePath -Encoding utf8
}

$changes = @()
foreach ($propertyName in $desired.Keys) {
  $property = Get-NetAdapterAdvancedProperty -Name $AdapterName -DisplayName $propertyName -ErrorAction SilentlyContinue
  if (-not $property) { continue }
  $target = $desired[$propertyName]
  if ($property.ValidDisplayValues -notcontains $target) { continue }
  if ($property.DisplayValue -eq $target) { continue }
  Set-NetAdapterAdvancedProperty -Name $AdapterName -DisplayName $propertyName -DisplayValue $target -NoRestart
  $changes += [pscustomobject]@{property=$propertyName;from=$property.DisplayValue;to=$target}
}

if ($changes.Count -gt 0) { Restart-NetAdapter -Name $AdapterName -Confirm:$false }
$after = Get-LinkState
[pscustomobject]@{
  schema = 'orange.ae-pulse.link-tuning.v1'
  ok = $after.adapter.Status -eq 'Up'
  mode = 'Apply'
  baselinePath = $baselinePath
  changes = $changes
  before = $before
  after = $after
} | ConvertTo-Json -Depth 10
