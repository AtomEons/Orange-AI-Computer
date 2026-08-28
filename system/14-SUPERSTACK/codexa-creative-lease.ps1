[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Manifest,
  [Parameter(Mandatory)][string]$Role,
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$ArgumentsBase64
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertFrom-Base64Json([string]$Value) {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
  return @($json | ConvertFrom-Json)
}

function Get-PathBytes([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction Stop
  if (-not $item.PSIsContainer) { return [long]$item.Length }
  return [long]((Get-ChildItem -LiteralPath $Path -Recurse -File -ErrorAction Stop | Measure-Object Length -Sum).Sum)
}

function Get-ProcessTree([int]$RootId) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  $ids = [Collections.Generic.HashSet[int]]::new()
  [void]$ids.Add($RootId)
  do {
    $changed = $false
    foreach ($row in $all) {
      if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed = $true }
    }
  } while ($changed)
  return @($ids)
}

function Get-TreeWorkingSet([int]$RootId) {
  $total = 0L
  foreach ($id in @(Get-ProcessTree $RootId)) {
    $process = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($process) { $total += [long]$process.WorkingSet64 }
  }
  return $total
}

function Stop-ProcessTree([int]$RootId) {
  foreach ($id in @((Get-ProcessTree $RootId) | Sort-Object -Descending)) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Ollama([string]$BaseUrl, [string]$Endpoint, [hashtable]$Body) {
  return Invoke-RestMethod -Method Post -Uri ($BaseUrl.TrimEnd('/') + $Endpoint) -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) -TimeoutSec 120
}

$registry = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$route = @($registry.roles | Where-Object role -eq $Role)
if ($route.Count -ne 1) { throw "Unknown or duplicate creative route: $Role" }
$route = $route[0]
$ceiling = [long]$registry.policy.live_model_memory_ceiling_bytes
$requested = [long]$route.estimated_live_bytes
if (-not $route.availability.lease_eligible) { throw "Route is not lease eligible: $Role ($($route.availability.state))" }
if ($requested -le 0 -or $requested -gt $ceiling) { throw "Route memory is unmeasured or over budget: $requested > $ceiling" }
$measurementState = [string]$route.memory_measurement.state
$measuredPeak = if ($null -ne $route.memory_measurement.peak_process_tree_working_set_bytes) {
  [long]$route.memory_measurement.peak_process_tree_working_set_bytes
} else { 0L }
$measurementReceipt = [string]$route.memory_measurement.receipt
if ($registry.policy.deny_unmeasured_memory -and (
  $measurementState -ne 'measured' -or $measuredPeak -le 0 -or [string]::IsNullOrWhiteSpace($measurementReceipt)
)) {
  throw "Route lacks a measured peak-memory receipt: $Role"
}
if ($measuredPeak -gt $ceiling) { throw "Measured route peak exceeds memory ceiling: $measuredPeak > $ceiling" }
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Runtime executable missing: $Executable" }

$inventory = @()
foreach ($artifact in @($route.required_artifacts)) {
  $exists = Test-Path -LiteralPath $artifact.path
  $bytes = if ($exists) { Get-PathBytes $artifact.path } else { 0L }
  $required = if ($null -ne $artifact.bytes) { [long]$artifact.bytes } else { [long]$artifact.minimum_bytes }
  $valid = $exists -and (
    ($null -ne $artifact.bytes -and $bytes -eq $required) -or
    ($null -eq $artifact.bytes -and $bytes -ge $required)
  )
  $inventory += [ordered]@{ path = $artifact.path; exists = $exists; bytes = $bytes; required_bytes = $required; valid = $valid }
}
if (@($inventory | Where-Object { -not $_.valid }).Count -gt 0) {
  throw "Required artifact inventory failed for route: $Role"
}

$mutex = [Threading.Mutex]::new($false, [string]$registry.policy.lease_mutex)
$acquired = $false
$priorOllama = @()
$process = $null
$peakWorkingSet = 0L
$stdoutPath = Join-Path $env:TEMP "orange5-$Role-stdout.log"
$stderrPath = Join-Path $env:TEMP "orange5-$Role-stderr.log"
$receiptRoot = [string]$registry.hosts.worker_receipt_root
New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$receiptPath = Join-Path $receiptRoot ("{0}-{1}.json" -f ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')), $Role)
$result = [ordered]@{
  schema = 'orange.creative-worker-lease.v1'
  status = 'LEASE_FAILED'
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  role = $Role
  model = $route.model
  ceiling_bytes = $ceiling
  declared_live_bytes = $requested
  measured_peak_process_tree_working_set_bytes = $measuredPeak
  memory_measurement_receipt = $measurementReceipt
  inventory = $inventory
  command_exit_code = $null
  peak_process_tree_working_set_bytes = 0
  execution_performed = $false
  artifact_proof_required = $true
  error = $null
}

try {
  $acquired = $mutex.WaitOne(0)
  if (-not $acquired) { throw 'Another Captain Planet creative lease is active' }

  $markers = @($registry.policy.creative_process_markers)
  $blockers = @(Get-CimInstance Win32_Process | Where-Object {
    $candidate = $_
    $candidate.ProcessId -ne $PID -and $candidate.CommandLine -and ($markers | Where-Object { $_ -and $candidate.CommandLine -like "*$_*" }).Count -gt 0
  } | Select-Object ProcessId,Name,CommandLine)
  if ($blockers.Count -gt 0) { throw "Creative worker already active: $($blockers.ProcessId -join ',')" }

  $ollama = [string]$registry.ollama.worker_base_url
  try {
    $state = Invoke-RestMethod -Uri ($ollama.TrimEnd('/') + '/api/ps') -TimeoutSec 10
    $priorOllama = @($state.models | ForEach-Object { $_.name })
    foreach ($model in $priorOllama) {
      [void](Invoke-Ollama $ollama '/api/generate' @{ model = $model; prompt = ''; stream = $false; keep_alive = 0 })
    }
  } catch {
    throw "Ollama unload boundary failed: $($_.Exception.Message)"
  }

  $arguments = ConvertFrom-Base64Json $ArgumentsBase64
  Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $Executable -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $result.execution_performed = $true

  while (-not $process.HasExited) {
    $workingSet = Get-TreeWorkingSet $process.Id
    if ($workingSet -gt $peakWorkingSet) { $peakWorkingSet = $workingSet }
    if ($workingSet -gt $ceiling) {
      Stop-ProcessTree $process.Id
      throw "50 GiB working-set watchdog exceeded: $workingSet > $ceiling"
    }
    Start-Sleep -Milliseconds 500
    $process.Refresh()
  }

  $result.command_exit_code = $process.ExitCode
  $result.peak_process_tree_working_set_bytes = $peakWorkingSet
  if ($process.ExitCode -ne 0) {
    $stderr = if (Test-Path $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    throw "Creative command failed with exit $($process.ExitCode): $stderr"
  }
  $result.status = 'LEASE_COMMAND_COMPLETED_ARTIFACT_PROOF_REQUIRED'
} catch {
  $result.error = $_.Exception.Message
  if ($process -and -not $process.HasExited) { Stop-ProcessTree $process.Id }
} finally {
  $result.peak_process_tree_working_set_bytes = $peakWorkingSet
  if ($priorOllama.Count -gt 0 -and $registry.policy.restore_one_prior_ollama_model_after_external_lease) {
    try {
      [void](Invoke-Ollama ([string]$registry.ollama.worker_base_url) '/api/generate' @{ model = $priorOllama[0]; prompt = ''; stream = $false; keep_alive = '30m' })
      $result.restored_ollama_model = $priorOllama[0]
    } catch {
      $result.restore_error = $_.Exception.Message
    }
  }
  if ($acquired) { $mutex.ReleaseMutex() }
  $mutex.Dispose()
  $result.completed_at = (Get-Date).ToUniversalTime().ToString('o')
  $result.stdout_path = $stdoutPath
  $result.stderr_path = $stderrPath
  $result | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
}

[ordered]@{ status = $result.status; role = $Role; receipt_path = $receiptPath; error = $result.error } | ConvertTo-Json -Depth 4
if ($result.status -ne 'LEASE_COMMAND_COMPLETED_ARTIFACT_PROOF_REQUIRED') { exit 1 }
