param(
  [string]$PreflightPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\preflight.ps1')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Equal([object]$Actual, [object]$Expected, [string]$Message) {
  if ([string]$Actual -ne [string]$Expected) { throw "$Message; expected=$Expected actual=$Actual" }
}

$tokens = $null
$errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($PreflightPath, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "Preflight parser errors: $($errors.Message -join '; ')" }
$functionNames = @('Get-OptionalProperty', 'Resolve-ProcessChain', 'Test-ProcessChainOwners', 'Get-ListenerOwnerAssessment')
$definitions = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -in $functionNames
}, $true))
Assert-Equal $definitions.Count $functionNames.Count 'Expected preflight helper functions were not found'
foreach ($definition in $definitions) { . ([scriptblock]::Create($definition.Extent.Text)) }

function New-FixtureProcess([int]$ProcessId, [int]$ParentProcessId, [string]$OwnerSid, [string]$CommandLine = '') {
  [pscustomobject]@{
    ProcessId = $ProcessId
    ParentProcessId = $ParentProcessId
    OwnerSid = $OwnerSid
    CommandLine = $CommandLine
    ExecutablePath = 'C:\fixture\venv\Scripts\hermes.exe'
    CreationDate = [DateTime]'2026-08-27T05:17:00Z'
  }
}

$currentSid = 'S-1-5-21-1000'
$systemSid = 'S-1-5-18'
$ownerResolver = {
  param($Process)
  [ordered]@{ ok = [bool]$Process.OwnerSid; sid = [string]$Process.OwnerSid; name = [string]$Process.OwnerSid }
}
$listener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 4202 }
$launch = [pscustomobject]@{ pid = 4200 }
$wrapperHeavyProcesses = @(
  (New-FixtureProcess 4202 4201 $currentSid 'hermes gateway run --external-supervisor'),
  (New-FixtureProcess 4201 4200 $currentSid 'python hermes gateway run --external-supervisor'),
  (New-FixtureProcess 4200 100 $currentSid 'cmd /c gateway-owner.cmd'),
  (New-FixtureProcess 4199 100 $currentSid 'powershell start-owner.ps1 hermes gateway')
)

$assessment = Get-ListenerOwnerAssessment @($listener) $wrapperHeavyProcesses $launch $currentSid $ownerResolver
Assert-Equal $assessment.status 'PASS' 'Actual listener owner should be selected despite wrapper and ancestor matches'
Assert-Equal $assessment.process.ProcessId 4202 'Listener owner PID should drive process selection'
Assert-Equal ($assessment.chain.ids -join '>') '4202>4201>4200' 'Listener owner should trace to the launch-manifest PID'

$detachedProcess = New-FixtureProcess 4302 4301 $currentSid '"C:\fixture\venv\Scripts\hermes.exe" gateway run --external-supervisor'
$detachedListener = [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 4302 }
$detachedAssessment = Get-ListenerOwnerAssessment @($detachedListener) @($detachedProcess) ([pscustomobject]@{ pid = 4300; startTime = '2026-08-27T05:16:30Z' }) $currentSid $ownerResolver
Assert-Equal $detachedAssessment.status 'PASS' 'A detached interpreter entrypoint should pass when it started inside the recorded launch window'
Assert-True ($detachedAssessment.chain.detached -eq $true) 'Detached listener proof should remain explicit'

$detachedProcess.CreationDate = [DateTime]'2026-08-27T04:00:00Z'
$predatingAssessment = Get-ListenerOwnerAssessment @($detachedListener) @($detachedProcess) ([pscustomobject]@{ pid = 4300; startTime = '2026-08-27T05:16:30Z' }) $currentSid $ownerResolver
Assert-Equal $predatingAssessment.status 'FAIL' 'A detached listener that predates the launch manifest must fail'
Assert-True ($predatingAssessment.reason -like 'detached-process-time-outside-launch-window*') 'Detached launch-window failure should be explicit'

$systemProcesses = @(
  (New-FixtureProcess 5201 5200 $systemSid 'hermes gateway run --external-supervisor'),
  (New-FixtureProcess 5200 100 $systemSid 'cmd /c gateway-owner.cmd')
)
$systemAssessment = Get-ListenerOwnerAssessment @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 5201 }) $systemProcesses ([pscustomobject]@{ pid = 5200 }) $currentSid $ownerResolver
Assert-Equal $systemAssessment.status 'PASS' 'A SYSTEM-owned scheduled-task process chain should be accepted'

$untrustedProcesses = @(
  (New-FixtureProcess 6201 6200 'S-1-5-21-9999' 'hermes gateway run --external-supervisor'),
  (New-FixtureProcess 6200 100 $currentSid 'cmd /c gateway-owner.cmd')
)
$untrustedAssessment = Get-ListenerOwnerAssessment @([pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 6201 }) $untrustedProcesses ([pscustomobject]@{ pid = 6200 }) $currentSid $ownerResolver
Assert-Equal $untrustedAssessment.status 'FAIL' 'An unrelated process owner must remain rejected'
Assert-True ($untrustedAssessment.reason -like 'untrusted-process-chain-owner=*') 'Untrusted owner failure should identify the process chain'

$duplicateAssessment = Get-ListenerOwnerAssessment @(
  [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 4202 },
  [pscustomobject]@{ LocalAddress = '127.0.0.1'; LocalPort = 8642; OwningProcess = 7202 }
) $wrapperHeavyProcesses $launch $currentSid $ownerResolver
Assert-Equal $duplicateAssessment.status 'FAIL' 'Duplicate listeners must remain rejected'
Assert-Equal $duplicateAssessment.reason 'listener-count=2' 'Duplicate listener count should be explicit'

$wildcardAssessment = Get-ListenerOwnerAssessment @([pscustomobject]@{ LocalAddress = '0.0.0.0'; LocalPort = 8642; OwningProcess = 4202 }) $wrapperHeavyProcesses $launch $currentSid $ownerResolver
Assert-Equal $wildcardAssessment.status 'FAIL' 'Wildcard binding must remain rejected'
Assert-Equal $wildcardAssessment.reason 'listener-address=0.0.0.0' 'Only exact IPv4 loopback binding should pass'

'Preflight runtime ownership PASS (wrapper, detached entrypoint, SYSTEM, strict owner, duplicate listener, loopback)'
