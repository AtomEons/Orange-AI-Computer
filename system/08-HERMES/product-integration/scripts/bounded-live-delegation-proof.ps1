[CmdletBinding()]
param(
  [string]$OrangeMcpUrl = 'http://127.0.0.1:17431/mcp',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$AgentModel = 'orange-navigator:ornith-1.5-9b-q4km',
  [string]$SynthesisModel = 'orange-navigator:ornith-1.5-9b-q4km',
  [int]$TimeoutSec = 480,
  [string]$ResumeTaskId,
  [switch]$WriteReceipt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Protocol = '2026-07-28'
$Checks = [Collections.Generic.List[object]]::new()
$started = Get-Date

function Add-Check([string]$Name, [bool]$Pass, [string]$Evidence) {
  $Checks.Add([ordered]@{ name = $Name; status = if ($Pass) { 'PASS' } else { 'FAIL' }; evidence = $Evidence })
}

function Get-LatestReceipt([string]$Pattern) {
  $receiptRoot = Join-Path $DataRoot 'receipts'
  $match = Get-ChildItem -LiteralPath $receiptRoot -Filter $Pattern -File |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if (-not $match) { throw "required evidence receipt not found: $Pattern" }
  return $match
}

$deploymentFile = Get-LatestReceipt 'hermes-profile-deployment-*.json'
$preflightFile = Get-LatestReceipt 'hermes-product-preflight-*.json'
$deployment = Get-Content -LiteralPath $deploymentFile.FullName -Raw | ConvertFrom-Json
$preflight = Get-Content -LiteralPath $preflightFile.FullName -Raw | ConvertFrom-Json
$deploymentHash = (Get-FileHash -LiteralPath $deploymentFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$preflightHash = (Get-FileHash -LiteralPath $preflightFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
$requiredChecks = @($preflight.checks | Where-Object { $_.required -eq $true })
$requiredPassed = @($requiredChecks | Where-Object { $_.status -eq 'PASS' }).Count
$requiredFailed = @($requiredChecks | Where-Object { $_.status -ne 'PASS' })
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1
$resident = $null
try {
  $resident = @((Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/ps' -TimeoutSec 10).models) |
    Where-Object { $_.name -eq 'orange-navigator:ornith-1.5-9b-q4km' } |
    Select-Object -First 1
} catch { }
$residentName = if ($resident) { [string]$resident.name } else { 'not-resident-before-task' }
$residentSize = if ($resident) { [string]$resident.size } else { '0' }
$residentExpiry = if ($resident) { [string]$resident.expires_at } else { 'none' }

$deploymentRef = "receipt:$($deploymentFile.BaseName):sha256=$($deploymentHash.Substring(0, 16))"
$preflightRef = "receipt:$($preflightFile.BaseName):required=$requiredPassed/$($requiredChecks.Count)"
$profileHashSummary = @($deployment.after | Sort-Object profile | ForEach-Object {
  $profileHash = [string]$_.sha256
  "$($_.profile)=$($profileHash.Substring(0, 12))"
}) -join ','
$failedSummary = if ($requiredFailed.Count) {
  @($requiredFailed | ForEach-Object { "$($_.name)=$($_.status)" }) -join ','
} else { 'none' }
$proofConstraints = @(
  "Deployment artifact $($deploymentFile.Name) has SHA256 $deploymentHash and records six post-deploy profile hashes.",
  "Six deployed profile hash prefixes are $profileHashSummary.",
  "Hermes-only restart evidence is status=$($deployment.restart.status), listenerPid=$($deployment.restart.listenerPid); live listenerPid=$($listener.OwningProcess).",
  "Strict preflight artifact $($preflightFile.Name) has SHA256 $preflightHash and required checks $requiredPassed/$($requiredChecks.Count); failures=$failedSummary.",
  "Pre-task model state is $residentName, size=$residentSize, expires=$residentExpiry; the task pins canonical Q4KM and may lease it on demand.",
  'Judge only whether this bounded Q4KM delegation route executes under Hermes authorization; do not claim the full Hermes deployment green.'
)

$orderId = "hermes-live-$([Guid]::NewGuid().ToString('N').Substring(0, 12))"
$forbidden = @('destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded')
$request = [ordered]@{
  jsonrpc = '2.0'
  id = 81
  method = 'tools/call'
  params = [ordered]@{
    name = 'orange5_delegate'
    arguments = [ordered]@{
      execute = $true
      maxAgents = 1
      agentModel = $AgentModel
      synthesisModel = $SynthesisModel
      order = [ordered]@{
        orderId = $orderId
        action = 'audit.security'
        intent = 'Produce one evidence-based orange.report.v1 for this bounded read-only Q4KM delegation. Copy both supplied top-level receipt evidence refs into report.evidence; report.evidence must not be empty. Judge only the bounded Hermes-authorized path.'
        targetProject = 'OrangeFive/08-HERMES'
        objective = 'Prove the bounded child and synthesis route only; preserve the separate strict-preflight limitation.'
        constraints = $proofConstraints
        riskLevel = 'read_only'
        allowedActions = @('audit.security')
        forbiddenActions = $forbidden
        requiresReceipt = $true
        maxAgents = 1
        evidence = @($deploymentRef, $preflightRef)
      }
    }
    _meta = [ordered]@{
      'io.modelcontextprotocol/protocolVersion' = $Protocol
      'io.modelcontextprotocol/clientInfo' = @{ name = 'orange5-hermes-bounded-live-proof'; version = '1.0.0' }
      'io.modelcontextprotocol/clientCapabilities' = @{
        extensions = @{ 'io.modelcontextprotocol/tasks' = @{} }
      }
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
$pollHeaders = @{
  Accept = 'application/json, text/event-stream'
  'Content-Type' = 'application/json'
  'MCP-Protocol-Version' = $Protocol
  'Mcp-Method' = 'tasks/get'
}
$cancelHeaders = @{
  Accept = 'application/json, text/event-stream'
  'Content-Type' = 'application/json'
  'MCP-Protocol-Version' = $Protocol
  'Mcp-Method' = 'tasks/cancel'
}

$delegation = $null
$taskId = $null
try {
  $pollMs = 1000
  if (-not [string]::IsNullOrWhiteSpace($ResumeTaskId)) {
    $taskId = $ResumeTaskId
    Add-Check 'mcp-task-created' $true "taskId=$taskId;status=resumed-after-transport-repair"
  } else {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $OrangeMcpUrl -Method Post -Headers $headers -Body ($request | ConvertTo-Json -Depth 14 -Compress) -TimeoutSec 20
    $rpc = $response.Content | ConvertFrom-Json
    $rpcError = if ($rpc.PSObject.Properties['error']) { $rpc.error } else { $null }
    if ($response.StatusCode -ne 200 -or $rpcError) { throw "MCP task creation failed: status=$($response.StatusCode); error=$rpcError" }
    if (-not $rpc.PSObject.Properties['result'] -or $rpc.result.resultType -ne 'task' -or [string]::IsNullOrWhiteSpace([string]$rpc.result.taskId)) {
      throw 'MCP server did not create a durable task for orange5_delegate.'
    }
    $taskId = [string]$rpc.result.taskId
    Add-Check 'mcp-task-created' $true "taskId=$taskId;status=$($rpc.result.status)"
    $pollMs = [math]::Max(250, [math]::Min(2000, [int]$rpc.result.pollIntervalMs))
  }

  $deadline = $started.AddSeconds($TimeoutSec)
  $terminal = $null
  $pollId = 82
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $pollMs
    $pollRequest = [ordered]@{
      jsonrpc = '2.0'
      id = $pollId++
      method = 'tasks/get'
      params = [ordered]@{
        taskId = $taskId
        _meta = [ordered]@{
          'io.modelcontextprotocol/protocolVersion' = $Protocol
          'io.modelcontextprotocol/clientCapabilities' = @{
            extensions = @{ 'io.modelcontextprotocol/tasks' = @{} }
          }
        }
      }
    }
    $pollResponse = Invoke-WebRequest -UseBasicParsing -Uri $OrangeMcpUrl -Method Post -Headers $pollHeaders -Body ($pollRequest | ConvertTo-Json -Depth 12 -Compress) -TimeoutSec 20
    $pollRpc = $pollResponse.Content | ConvertFrom-Json
    if ($pollRpc.PSObject.Properties['error']) { throw "MCP task poll failed: $($pollRpc.error.message)" }
    if ($pollRpc.result.status -in @('completed', 'failed', 'cancelled')) {
      $terminal = $pollRpc.result
      break
    }
  }
  if (-not $terminal) {
    $cancelRequest = [ordered]@{
      jsonrpc = '2.0'; id = $pollId; method = 'tasks/cancel'
      params = [ordered]@{
        taskId = $taskId
        _meta = [ordered]@{
          'io.modelcontextprotocol/protocolVersion' = $Protocol
          'io.modelcontextprotocol/clientCapabilities' = @{
            extensions = @{ 'io.modelcontextprotocol/tasks' = @{} }
          }
        }
      }
    }
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $OrangeMcpUrl -Method Post -Headers $cancelHeaders -Body ($cancelRequest | ConvertTo-Json -Depth 12 -Compress) -TimeoutSec 20 | Out-Null
    } catch { }
    throw "durable delegation exceeded total bound of $TimeoutSec seconds and was cancelled"
  }
  if ($terminal.status -ne 'completed') {
    $terminalError = if ($terminal.PSObject.Properties['error']) { $terminal.error.message } else { $terminal.statusMessage }
    throw "durable delegation ended $($terminal.status): $terminalError"
  }
  $toolResult = $terminal.result
  Add-Check 'mcp-roundtrip' (@($toolResult.content).Count -gt 0) "taskId=$taskId;taskStatus=$($terminal.status);elapsedMs=$([int]((Get-Date)-$started).TotalMilliseconds)"
  if (@($toolResult.content).Count -gt 0) {
    $delegation = $toolResult.content[0].text | ConvertFrom-Json
  }
} catch {
  Add-Check 'mcp-roundtrip' $false "taskId=$taskId;error=$($_.Exception.Message);elapsedMs=$([int]((Get-Date)-$started).TotalMilliseconds)"
}

if ($delegation) {
  $reports = @($delegation.reports)
  $synthesis = $delegation.synthesis
  $governance = $delegation.governance
  $gateResults = @($governance.hermesGateResults)
  $allGates = @($gateResults | ForEach-Object { @($_.gates) })
  $firstReport = if ($reports.Count) { $reports[0] } else { $null }
  $reportStatus = if ($firstReport) { [string]$firstReport.result.status } else { '' }
  $synthesisStatus = if ($synthesis) { [string]$synthesis.result.status } else { '' }
  $delegationError = if ($delegation.PSObject.Properties['error']) { [string]$delegation.error } else { '' }
  $completeStatuses = @('completed', 'complete', 'green', 'pass', 'success')
  $reportComplete = $reports.Count -eq 1 -and $firstReport.ok -eq $true -and ($completeStatuses -contains $reportStatus)
  $synthesisComplete = $synthesis -and $synthesis.ok -eq $true -and ($completeStatuses -contains $synthesisStatus)
  Add-Check 'delegation-complete' ($delegation.status -eq 'DELEGATION_COMPLETE') "status=$($delegation.status);error=$delegationError"
  Add-Check 'single-child-report' $reportComplete "reports=$($reports.Count);ok=$(if($firstReport){$firstReport.ok}else{$false});status=$reportStatus"
  Add-Check 'synthesis-complete' $synthesisComplete "present=$([bool]$synthesis);ok=$(if($synthesis){$synthesis.ok}else{$false});status=$synthesisStatus"
  Add-Check 'orders-mediated' ($governance.childOrdersMediated -eq $true -and $governance.synthesisMediated -eq $true) "child=$($governance.childOrdersMediated);synthesis=$($governance.synthesisMediated)"
  Add-Check 'models-pinned' ($governance.agentModel -eq $AgentModel -and $governance.synthesisModel -eq $SynthesisModel) "agent=$($governance.agentModel);synthesis=$($governance.synthesisModel)"
  Add-Check 'hermes-authorizations' ($governance.hermesAuthorizedActions -eq 2 -and $gateResults.Count -eq 2) "authorized=$($governance.hermesAuthorizedActions);results=$($gateResults.Count)"
  Add-Check 'all-hermes-gates' ($gateResults.Count -eq 2 -and $allGates.Count -eq 16 -and @($gateResults | Where-Object { $_.pass -ne $true }).Count -eq 0 -and @($allGates | Where-Object { $_.pass -ne $true }).Count -eq 0) "authorizations=$($gateResults.Count);gates=$($allGates.Count);failed=$(@($allGates | Where-Object { $_.pass -ne $true }).Count)"
  Add-Check 'lease-revoked' ($governance.hermesLeaseRevoked -eq $true) "lease=$($governance.hermesLeaseId);revoked=$($governance.hermesLeaseRevoked)"
} else {
  Add-Check 'delegation-payload' $false 'MCP response did not contain a delegation payload.'
}

$failed = @($Checks | Where-Object status -ne 'PASS')
$report = [ordered]@{
  schema = 'orange5.hermes-bounded-live-delegation-proof.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  status = if ($failed.Count) { 'FAIL' } else { 'PASS' }
  orderId = $orderId
  mcpTaskId = $taskId
  elapsedMs = [int]((Get-Date) - $started).TotalMilliseconds
  endpoint = $OrangeMcpUrl
  agentModel = $AgentModel
  synthesisModel = $SynthesisModel
  mutatedProject = $false
  evidenceInputs = [ordered]@{
    deploymentReceipt = $deploymentFile.FullName
    deploymentSha256 = $deploymentHash
    preflightReceipt = $preflightFile.FullName
    preflightSha256 = $preflightHash
    requiredPreflight = "$requiredPassed/$($requiredChecks.Count)"
    requiredPreflightFailures = @($requiredFailed | ForEach-Object name)
    hermesListenerPid = if ($listener) { $listener.OwningProcess } else { $null }
    residentModel = if ($resident) { $residentName } else { $null }
    modelIdleBeforeTask = -not [bool]$resident
  }
  checks = $Checks
  blockers = @($failed | ForEach-Object name)
  delegation = $delegation
  receiptPath = $null
}

if ($WriteReceipt) {
  $receiptRoot = Join-Path $DataRoot 'receipts'
  New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
  $receiptPath = Join-Path $receiptRoot "hermes-bounded-live-delegation-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')).json"
  $report.receiptPath = $receiptPath
  [IO.File]::WriteAllText($receiptPath, ($report | ConvertTo-Json -Depth 20), [Text.UTF8Encoding]::new($false))
}

$report | ConvertTo-Json -Depth 20
if ($failed.Count) { exit 1 }
