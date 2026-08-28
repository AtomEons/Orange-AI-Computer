[CmdletBinding()]
param(
  [string]$OrangeMcpUrl = 'http://127.0.0.1:17431/mcp',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [int]$TimeoutSec = 30,
  [switch]$WriteReceipt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Protocol = '2026-07-28'
$RequiredForbidden = @('destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded')
$Checks = New-Object Collections.Generic.List[object]

function Add-Check([string]$Name, [bool]$Pass, [string]$Evidence) {
  $Checks.Add([ordered]@{ name = $Name; status = if ($Pass) { 'PASS' } else { 'FAIL' }; evidence = $Evidence })
}

$request = [ordered]@{
  jsonrpc = '2.0'
  id = 71
  method = 'tools/call'
  params = [ordered]@{
    name = 'orange5_delegate'
    arguments = [ordered]@{
      execute = $false
      order = [ordered]@{
        action = 'inspect.hermes-product'
        intent = 'Prove bounded Hermes agent lease planning without executing tools or mutations.'
        targetProject = 'OrangeFive/08-HERMES'
        riskLevel = 'read_only'
        allowedActions = @('inspect.hermes-product')
        forbiddenActions = $RequiredForbidden
        maxAgents = 1
      }
    }
    _meta = [ordered]@{
      'io.modelcontextprotocol/protocolVersion' = $Protocol
      'io.modelcontextprotocol/clientInfo' = @{ name = 'orange5-hermes-agent-lease-proof'; version = '1.0.0' }
      'io.modelcontextprotocol/clientCapabilities' = @{}
    }
  }
}
$headers = @{
  Accept = 'application/json, text/event-stream'
  'Content-Type' = 'application/json'
  'MCP-Protocol-Version' = $Protocol
  'Mcp-Method' = 'tools/call'
  'Mcp-Name' = 'orange5_delegate'
}

$plan = $null
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $OrangeMcpUrl -Method Post -Headers $headers -Body ($request | ConvertTo-Json -Depth 12 -Compress) -TimeoutSec $TimeoutSec
  $rpc = $response.Content | ConvertFrom-Json
  $rpcError = if ($rpc.PSObject.Properties['error']) { $rpc.error } else { $null }
  $errorMessage = if ($rpcError -and $rpcError.PSObject.Properties['message']) { $rpcError.message } else { '' }
  Add-Check 'mcp-http' ($response.StatusCode -eq 200 -and -not $rpcError) "status=$($response.StatusCode);error=$errorMessage"
  if ($rpc.PSObject.Properties['result'] -and @($rpc.result.content).Count -gt 0) {
    $plan = $rpc.result.content[0].text | ConvertFrom-Json
  }
} catch {
  Add-Check 'mcp-http' $false $_.Exception.Message
}

if ($plan) {
  $lease = $plan.hermesLease
  $forbidden = @($lease.forbiddenActions | Sort-Object -Unique)
  $required = @($RequiredForbidden | Sort-Object -Unique)
  $forbiddenOk = $forbidden.Count -eq $required.Count -and -not (Compare-Object $forbidden $required)
  $tools = @($lease.allowedTools | Sort-Object -Unique)
  $toolsOk = $tools.Count -eq 2 -and $tools[0] -eq 'read' -and $tools[1] -eq 'receipts'
  $timeOk = ([DateTimeOffset]::Parse($lease.expiresAt) - [DateTimeOffset]::Parse($lease.issuedAt)).TotalMinutes -eq 30
  Add-Check 'planned-not-executed' ($plan.status -eq 'PLANNED_NOT_EXECUTED' -and $plan.reports.Count -eq 0) "status=$($plan.status);reports=$($plan.reports.Count)"
  Add-Check 'single-agent-bound' ($lease.maxConcurrentAgents -eq 1 -and $lease.allowedAgents.Count -eq 1) "max=$($lease.maxConcurrentAgents);agents=$($lease.allowedAgents -join ',')"
  Add-Check 'read-receipts-only' $toolsOk "tools=$($tools -join ',')"
  Add-Check 'forbidden-actions' $forbiddenOk "forbidden=$($forbidden -join ',')"
  Add-Check 'receipt-required' ($lease.requiresReceipt -eq $true) "requiresReceipt=$($lease.requiresReceipt)"
  Add-Check 'lease-expiry' $timeOk "issued=$($lease.issuedAt);expires=$($lease.expiresAt)"
  Add-Check 'zero-resident-router' ($plan.topNavigator.modelResident -eq $false) "modelResident=$($plan.topNavigator.modelResident);route=$($plan.route.model)"
} else {
  Add-Check 'lease-plan' $false 'MCP response did not contain a delegation plan.'
}

$failed = @($Checks | Where-Object { $_.status -ne 'PASS' })
$report = [ordered]@{
  schema = 'orange5.hermes-agent-lease-proof.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  status = if ($failed.Count) { 'FAIL' } else { 'PASS' }
  endpoint = $OrangeMcpUrl
  executed = $false
  mutatedProject = $false
  planHash = if ($plan) { $plan.planHash } else { $null }
  lease = if ($plan) { $plan.hermesLease } else { $null }
  checks = $Checks
  blockers = @($failed | ForEach-Object { $_.name })
  receiptPath = $null
}

if ($WriteReceipt) {
  $receiptRoot = Join-Path $DataRoot 'receipts'
  New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
  $receiptPath = Join-Path $receiptRoot "hermes-agent-lease-proof-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')).json"
  $report.receiptPath = $receiptPath
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receiptPath -Encoding utf8
}

$report | ConvertTo-Json -Depth 12
if ($failed.Count) { exit 1 }
