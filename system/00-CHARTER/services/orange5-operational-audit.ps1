$ErrorActionPreference = "Continue"

$Root = "C:\AtomEons\Orange5"
$ReceiptDir = Join-Path $Root "10-RECEIPTS\orange5-build"
$LogDir = Join-Path $ReceiptDir "logs"
New-Item -ItemType Directory -Force -Path $ReceiptDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$receiptPath = Join-Path $ReceiptDir "orange5-operational-audit-$stamp.json"

function Test-Port {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(800, $false)
    if ($ok) { $client.EndConnect($async) }
    $client.Close()
    return [bool]$ok
  } catch {
    return $false
  }
}

function File-Exists {
  param([string]$Path)
  return [bool](Test-Path $Path)
}

function Invoke-JsonProbe {
  param(
    [string]$Uri,
    [string]$Method = "GET",
    [hashtable]$Headers = @{},
    [object]$Body = $null
  )
  try {
    $params = @{ Uri = $Uri; Method = $Method; Headers = $Headers; TimeoutSec = 15 }
    if ($null -ne $Body) {
      $params.ContentType = "application/json"
      $params.Body = ($Body | ConvertTo-Json -Depth 8 -Compress)
    }
    $body = Invoke-RestMethod @params
    return [ordered]@{ reached = $true; body = $body; error = $null }
  } catch {
    return [ordered]@{ reached = $false; body = $null; error = $_.Exception.Message }
  }
}

function Get-RailToken {
  if ($env:ORANGEBOX_RAIL_TOKEN) { return $env:ORANGEBOX_RAIL_TOKEN }
  return [Environment]::GetEnvironmentVariable("ORANGEBOX_RAIL_TOKEN", "User")
}

function Test-SemanticFeature {
  param([string]$Id)

  switch ($Id) {
    "orange5_gateway" {
      $p = Invoke-JsonProbe "http://127.0.0.1:1337/healthz"
      $codexaBacked = $p.body.primary.host -eq "codexa" -or
        ($p.body.fabric.navigatorNodeId -in @("codexa", "codexa-tunnel") -and
         $p.body.fabric.navigatorPhysicalRemote -eq $true)
      $leasedOnDemand = $p.body.upstream.navigator.capability_mode -eq "lease_on_demand" -and
        $p.body.upstream.navigator.primary.model_available -eq $true
      $residencyReady = $p.body.primary.warm -eq $true -or $leasedOnDemand
      $ok = $p.reached -and $p.body.status -eq "ok" -and
        $p.body.primary.live -eq $true -and $residencyReady -and
        $codexaBacked -and $p.body.primary.model
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "gateway ok; Codexa primary=$($p.body.primary.model); residency=$(if($p.body.primary.warm){'warm'}else{'lease_on_demand'}); node=$($p.body.fabric.navigatorNodeId); transport=$($p.body.primary.host)" } else { $p.error } }
    }
    "hermes_mcp" {
      $p = Invoke-JsonProbe "http://127.0.0.1:7430/healthz"
      $ok = $p.reached -and $p.body.ok -eq $true -and $p.body.data.status -eq "alive" -and
        $p.body.data.gates -eq 8 -and $null -eq $p.body.data.misfit.load_error
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "alive; gates=$($p.body.data.gates); active_leases=$($p.body.data.active_leases)" } else { $p.error } }
    }
    "navigator_kernel" {
      $output = & bun test (Join-Path $Root "03-BACKEND\tests\navigator-kernel.test.mjs") 2>&1
      $ok = $LASTEXITCODE -eq 0
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($ok) { "navigator kernel executable test passed" } else { (($output | Select-Object -Last 3) -join " ") } }
    }
    "codexa_command_rail" {
      $token = Get-RailToken
      if (-not $token) {
        return [ordered]@{ checked = $true; ok = $false; evidence = "rail token unavailable to audit process" }
      }
      $p = Invoke-JsonProbe -Uri "http://10.0.0.4:8097/command" -Method "POST" `
        -Headers @{ "X-Orangebox-Token" = $token } `
        -Body @{ command = "hostname"; confirmFullAccess = $true }
      $ok = $p.reached -and $p.body.status -eq "VERIFIED" -and $p.body.exitCode -eq 0 -and
        $p.body.stdout.Trim() -eq "CODEXA" -and $p.body.machine.hostname -eq "CODEXA" -and
        $p.body.receiptPath
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "authenticated command verified; hostname=CODEXA; receipt=$($p.body.receiptPath)" } else { $p.error } }
    }
    "ae_eyes_colpali" {
      $p = Invoke-JsonProbe "http://127.0.0.1:7440/health"
      $ok = $p.reached -and $p.body.ok -eq $true -and
        $p.body.resident_worker.state -eq "ready" -and $p.body.backend -match "^transformers:xpu" -and
        $p.body.resident_worker.failures -eq 0 -and $p.body.resident_worker.pending -eq 0 -and
        $p.body.queue.queued -eq 0 -and $p.body.queue.running -eq 0
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "worker=$($p.body.resident_worker.state); backend=$($p.body.backend); worker_failures=$($p.body.resident_worker.failures); pending=$($p.body.resident_worker.pending); historical_queue_errors=$($p.body.queue.error)" } else { $p.error } }
    }
    "ae_cobra" {
      $p = Invoke-JsonProbe "http://127.0.0.1:7419/healthz"
      $ok = $p.reached -and $p.body.status -eq "ok" -and
        $p.body.upstream.processor.live -eq $true -and $p.body.upstream.flux_writer.live -eq $true -and
        $p.body.lanes.total -gt 0
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "processor live; flux live; records=$($p.body.lanes.total)" } else { $p.error } }
    }
    "ae_memory_recall" {
      $p = Invoke-JsonProbe -Uri "http://127.0.0.1:7419/state-brief" -Method "POST" `
        -Body @{ query = "OrangeFive"; time_range_ms = 2592000000; max_records = 20; include_conflicts = $true }
      $reality = @($p.body.reality)
      $allGrounded = $reality.Count -gt 0 -and @($reality | Where-Object {
        $pointer = $_.source_pointer
        $validFluxLedger = $pointer.ledger -eq "ae-cobra-flux" -and
          $pointer.hash -match "^[a-f0-9]{64}$"
        $validProjectSource = $pointer.type -eq "project-source" -and
          $pointer.file -and $pointer.section -and
          $pointer.source_hash -match "^[a-f0-9]{64}$" -and
          $pointer.hash -match "^[a-f0-9]{64}$"
        -not $_.summary -or (-not $validFluxLedger -and -not $validProjectSource)
      }).Count -eq 0
      $noEmptyThoughts = @($p.body.thought | Where-Object { -not $_.summary }).Count -eq 0
      $ok = $p.reached -and $p.body.schema -eq "orange5.state-brief.v0" -and
        $allGrounded -and $noEmptyThoughts -and $p.body.recommended_next_action
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "grounded_reality=$($reality.Count); empty_thoughts=$(@($p.body.thought | Where-Object { -not $_.summary }).Count); source_hashes_valid=$allGrounded" } else { $p.error } }
    }
    "ae_cobra_mirror" {
      $statusPath = Join-Path $env:USERPROFILE "OrangeBox-Data\orange5\ae-cobra-mirror-daemon-status.json"
      try {
        $body = Get-Content $statusPath -Raw | ConvertFrom-Json
        $ageSeconds = ((Get-Date).ToUniversalTime() - [datetime]::Parse($body.updatedAt).ToUniversalTime()).TotalSeconds
        $processAlive = $null -ne (Get-Process -Id $body.pid -ErrorAction SilentlyContinue)
        $resultOk = $body.lastResult.status -in @("VERIFIED", "UP_TO_DATE")
        $ok = $body.state -eq "healthy" -and $processAlive -and $resultOk -and
          $body.lastResult.fileCount -gt 0 -and $ageSeconds -le 1800
        return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = "state=$($body.state); pid_alive=$processAlive; files=$($body.lastResult.fileCount); age_seconds=$([math]::Round($ageSeconds))" }
      } catch {
        return [ordered]@{ checked = $true; ok = $false; evidence = $_.Exception.Message }
      }
    }
    "qdrant_visual_memory" {
      $p = Invoke-JsonProbe "http://127.0.0.1:6333/collections/orange5-vision"
      $ok = $p.reached -and $p.body.status -eq "ok" -and $p.body.result.status -eq "green" -and
        $p.body.result.optimizer_status -eq "ok" -and $p.body.result.points_count -gt 0
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "collection green; points=$($p.body.result.points_count)" } else { $p.error } }
    }
    "local_ollama" {
      $p = Invoke-JsonProbe "http://127.0.0.1:11434/api/tags"
      $names = @($p.body.models | ForEach-Object { $_.name })
      $ok = $p.reached -and $names.Count -gt 0 -and ($names -contains "nomic-embed-text:latest")
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "models=$($names.Count); embedding lane present" } else { $p.error } }
    }
    "atomsmasher2" {
      $p = Invoke-JsonProbe "http://127.0.0.1:8901/health"
      $ok = $p.reached -and $p.body.ok -eq $true -and $p.body.service -eq "atomsmasher2" -and
        $p.body.counts.features -eq 620 -and $p.body.counts.receipts -gt 0
      return [ordered]@{ checked = $true; ok = [bool]$ok; evidence = if ($p.reached) { "features=$($p.body.counts.features); receipts=$($p.body.counts.receipts)" } else { $p.error } }
    }
    default {
      return [ordered]@{ checked = $false; ok = $false; evidence = "no semantic probe registered" }
    }
  }
}

function New-Feature {
  param(
    [string]$Id,
    [string]$Name,
    [string]$Lane,
    [string]$Entrypoint,
    [int[]]$Ports = @(),
    [string[]]$ProofFiles = @(),
    [string]$OperationalTest = "",
    [bool]$ReleaseRequired = $true
  )

  $entryExists = if ($Entrypoint) { File-Exists $Entrypoint } else { $true }
  $portResults = @()
  foreach ($p in $Ports) {
    $portResults += [ordered]@{ port = $p; open = Test-Port -Port $p }
  }
  $proofResults = @()
  foreach ($pf in $ProofFiles) {
    $proofResults += [ordered]@{ path = $pf; exists = File-Exists $pf }
  }

  $portsOk = (($portResults | Where-Object { -not $_.open }).Count -eq 0)
  $proofsOk = (($proofResults | Where-Object { -not $_.exists }).Count -eq 0)
  $semantic = if ($ReleaseRequired) { Test-SemanticFeature -Id $Id } else { [ordered]@{ checked = $false; ok = $false; evidence = "retired compatibility path; direct Codexa route is authoritative" } }

  $status = if (-not $ReleaseRequired) {
    "REMOVED_FROM_SCOPE"
  } elseif ($entryExists -and $portsOk -and $proofsOk -and $semantic.checked -and $semantic.ok) {
    "OPERATIONAL"
  } elseif ($entryExists -and (($Ports.Count -eq 0) -or (($portResults | Where-Object { $_.open }).Count -gt 0))) {
    "DEGRADED_OPERATIONAL"
  } elseif ($entryExists) {
    "BLOCKED_NEEDS_OPERATOR_OR_HOST"
  } else {
    "BLOCKED_NEEDS_OPERATOR_OR_HOST"
  }

  return [ordered]@{
    id = $Id
    name = $Name
    lane = $Lane
    status = $status
    entrypoint = $Entrypoint
    entrypointExists = $entryExists
    ports = $portResults
    proofFiles = $proofResults
    operationalTest = $OperationalTest
    semantic = $semantic
    releaseRequired = $ReleaseRequired
  }
}

$features = @()

$features += New-Feature `
  -Id "orange5_gateway" `
  -Name "Orange5 Brain Gateway" `
  -Lane "control" `
  -Entrypoint "C:\AtomEons\Orange5\06-ORANGELLM\server\index.mjs" `
  -Ports @(1337) `
  -ProofFiles @("C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\orange5-hermes-mcp-full-green-20260705T054512Z.json") `
  -OperationalTest "GET /healthz and structured Orange report/order calls."

$features += New-Feature `
  -Id "hermes_mcp" `
  -Name "Hermes MCP Adapter" `
  -Lane "mcp" `
  -Entrypoint "C:\AtomEons\Orange5\08-HERMES\src\server.mjs" `
  -Ports @(7430) `
  -ProofFiles @("C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\hermes-mcp-smoke-20260704T234447.log") `
  -OperationalTest "MCP smoke must pass all adapter checks."

$features += New-Feature `
  -Id "navigator_kernel" `
  -Name "Navigator Kernel" `
  -Lane "deterministic_reflex" `
  -Entrypoint "C:\AtomEons\Orange5\03-BACKEND\navigator-kernel.mjs" `
  -ProofFiles @("C:\AtomEons\Orange5\03-BACKEND\tests\navigator-kernel.test.mjs") `
  -OperationalTest "Zero-resident-model route compilation and bounded Little Navigator Hermes lease tests."

$features += New-Feature `
  -Id "codexa_command_rail" `
  -Name "Authenticated Codexa Command Rail" `
  -Lane "two_host_execution" `
  -Entrypoint "C:\AtomEons\Orange5\scripts\codexa-orangefive-runtime.ps1" `
  -OperationalTest "Authenticated POST /command executes hostname on Codexa and returns a remote receipt."

$features += New-Feature `
  -Id "codexa_ollama_proxy" `
  -Name "Codexa Ollama Host Proxy" `
  -Lane "model_heavy" `
  -Entrypoint "C:\AtomEons\Orange5\docker\n150-runtime\codexa-ollama-host-proxy.mjs" `
  -Ports @(11435) `
  -OperationalTest "Retired compatibility proxy; OrangeBrain reaches Codexa Ollama directly." `
  -ReleaseRequired $false

$features += New-Feature `
  -Id "ae_eyes_colpali" `
  -Name "AE Eyes ColPali Service" `
  -Lane "visual" `
  -Entrypoint "C:\AtomEons\Orange5\07-VISUAL\colpali-service\server.mjs" `
  -Ports @(7440) `
  -ProofFiles @("C:\AtomEons\Orange5\07-VISUAL\tests\ae-eyes-backend.test.mjs","C:\AtomEons\Orange5\07-VISUAL\tests\visual-facade.test.mjs") `
  -OperationalTest "Image/document ingest and visual result returned through service."

$features += New-Feature `
  -Id "ae_cobra" `
  -Name "AE Cobra State/Visual Daemon" `
  -Lane "visual_memory" `
  -Entrypoint "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flow-direct\server.mjs" `
  -Ports @(7419) `
  -OperationalTest "State brief and visual memory lookup."

$features += New-Feature `
  -Id "ae_cobra_mirror" `
  -Name "AE Cobra Codexa Mirror Daemon" `
  -Lane "memory_continuity" `
  -Entrypoint "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\mirror-daemon.mjs" `
  -ProofFiles @((Join-Path $env:USERPROFILE "OrangeBox-Data\orange5\ae-cobra-mirror-daemon-status.json")) `
  -OperationalTest "Daemon process is alive, status is fresh and healthy, and a nonempty mirror is verified or up to date."

$features += New-Feature `
  -Id "ae_memory_recall" `
  -Name "AE Memory Grounded Recall" `
  -Lane "memory_recall" `
  -Entrypoint "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\mirage\state-brief.mjs" `
  -OperationalTest "Live state brief returns nonempty summaries with valid AE Cobra Flux source hashes and no rejection-only hot records."

$features += New-Feature `
  -Id "qdrant_visual_memory" `
  -Name "Qdrant Visual/Vector Memory" `
  -Lane "memory" `
  -Entrypoint "" `
  -Ports @(6333) `
  -OperationalTest "Vector service reachable and collection probe succeeds."

$features += New-Feature `
  -Id "local_ollama" `
  -Name "Local Ollama Endpoint" `
  -Lane "local_llm" `
  -Entrypoint "" `
  -Ports @(11434) `
  -OperationalTest "Local model tags/generate available."

$features += New-Feature `
  -Id "atomsmasher2" `
  -Name "AtomSmasher2 Runtime" `
  -Lane "compression" `
  -Entrypoint (Join-Path $env:USERPROFILE "OrangeBox-Data\atomsmasher2-final-local\start-daemon.mjs") `
  -Ports @(8901) `
  -OperationalTest "Health, receipt, demo, and compression proof endpoints."

$counts = [ordered]@{}
foreach ($s in @("OPERATIONAL","DEGRADED_OPERATIONAL","PACKAGED_UPGRADE","RESEARCH_ARCHIVE","REMOVED_FROM_SCOPE","BLOCKED_NEEDS_OPERATOR_OR_HOST")) {
  $counts[$s] = @($features | Where-Object { $_.status -eq $s }).Count
}

$receipt = [ordered]@{
  schema = "orange5.operational_audit.v1"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  root = $Root
  law = "Only live, callable, receipt-backed features may be operational."
  counts = $counts
  features = $features
  verdict = if ($counts["DEGRADED_OPERATIONAL"] -eq 0 -and $counts["PACKAGED_UPGRADE"] -eq 0 -and $counts["RESEARCH_ARCHIVE"] -eq 0 -and $counts["BLOCKED_NEEDS_OPERATOR_OR_HOST"] -eq 0) { "ORANGE5_ALL_REQUIRED_OPERATIONAL" } else { "ORANGE5_OPERATIONAL_INVENTORY_NEEDS_WORK" }
}

($receipt | ConvertTo-Json -Depth 10) | Set-Content -Encoding UTF8 $receiptPath
Write-Output $receiptPath
