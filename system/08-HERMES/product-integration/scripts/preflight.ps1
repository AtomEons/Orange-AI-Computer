[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\AtomEons\ai-box\hermes-product',
  [string]$DataRoot = 'C:\AtomEons\ai-box\hermes-product\data',
  [string]$OrangeModelUrl = 'http://127.0.0.1:11434/v1',
  [string]$OrangeMcpUrl = 'http://127.0.0.1:7431/mcp',
  [string]$StaffReactorUrl = 'http://127.0.0.1:8643',
  [switch]$ProbeAgentInference,
  [int]$AgentInferenceTimeoutSec = 90,
  [switch]$WriteReceipt
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PackRoot = Split-Path -Parent $PSScriptRoot
$Lock = Get-Content -LiteralPath (Join-Path $PackRoot 'upstream.lock.json') -Raw | ConvertFrom-Json
$HermesHome = Join-Path $DataRoot '.hermes'
$Checks = New-Object Collections.Generic.List[object]
$ExecutionProfilePolicy = @('builder', 'human-operator', 'misfit', 'navigator', 'researcher', 'reviewer', 'visual')
$ExpectedProfiles = @($ExecutionProfilePolicy)
$StaffRosterPath = Join-Path $PackRoot 'config\staff-roster.json'
$LogicalRoles = @()
$NavigatorRoleId = ''
$NavigatorProfile = 'navigator'
$ExpectedMcpTools = @('orange5_delegate', 'orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route')
$ExpectedProfileTools = @{
  navigator = @('orange5_delegate', 'orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route')
  builder = @('orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route')
  researcher = @('orange5_delegate', 'orange5_health', 'orange5_receipts')
  reviewer = @('orange5_health', 'orange5_receipts')
  visual = @('orange5_health', 'orange5_receipts')
  misfit = @('orange5_health', 'orange5_receipts')
  'human-operator' = @('orange5_health', 'orange5_order', 'orange5_receipts', 'orange5_route')
}
$ExpectedNativeToolsets = @('memory', 'session_search', 'todo')
$ExpectedProfileNativeToolsets = @{
  navigator = @('delegation', 'memory', 'session_search', 'todo')
  builder = @('file', 'memory', 'session_search', 'terminal', 'todo', 'web')
  researcher = @('browser', 'delegation', 'memory', 'session_search', 'todo', 'web')
  reviewer = @('memory', 'session_search', 'todo')
  visual = @('browser', 'memory', 'session_search', 'todo', 'vision')
  misfit = @('memory', 'session_search', 'todo')
  'human-operator' = @('memory', 'session_search', 'todo')
}

function Add-Check([string]$Name, [string]$Status, [string]$Evidence, [bool]$Required = $true) {
  $Checks.Add([ordered]@{ name = $Name; status = $Status; evidence = $Evidence; required = $Required })
}

function Get-HttpStatus([string]$Uri, [hashtable]$Headers = @{}, [int]$TimeoutSec = 5) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
    return [ordered]@{ status = [int]$response.StatusCode; response = $response; error = $null }
  } catch {
    $status = -1
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) { $status = [int]$_.Exception.Response.StatusCode }
    return [ordered]@{ status = $status; response = $null; error = $_.Exception.Message }
  }
}

function Get-OptionalProperty([object]$Object, [string]$Name) {
  if (-not $Object) { return $null }
  if ($Object -is [Collections.IDictionary] -and $Object.Contains($Name)) { return $Object[$Name] }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Test-ExactStringSet([object[]]$Actual, [string[]]$Expected) {
  $actualSorted = @($Actual | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $expectedSorted = @($Expected | Sort-Object -Unique)
  return $actualSorted.Count -eq $expectedSorted.Count -and -not (Compare-Object $actualSorted $expectedSorted)
}

function Test-NonEmptyStringList([object]$Value) {
  if ($null -eq $Value -or $Value -is [string]) { return $false }
  $items = @($Value)
  return $items.Count -gt 0 -and @($items | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace([string]$_) }).Count -eq 0
}

function Get-AeStaffRosterAssessment([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return [ordered]@{ status = 'BLOCKED'; ok = $false; error = "missing=$Path"; organization = $null; roles = @(); profiles = @(); declaredProfiles = @(); navigators = @(); navigatorId = ''; organizationOk = $false; idsOk = $false; profilesOk = $false; navigatorOk = $false; contractsOk = $false; workingStaffOk = $false; contractFailures = @(); managerialOnly = @(); reportingFailures = @() }
  }
  try {
    $parsed = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    $organization = Get-OptionalProperty $parsed 'organization'
    $roles = @((Get-OptionalProperty $parsed 'roles'))
    $ids = @($roles | ForEach-Object { [string](Get-OptionalProperty $_ 'id') })
    $uniqueIds = @($ids | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object -Unique)
    $invalidIds = @($ids | Where-Object { [string]::IsNullOrWhiteSpace($_) -or $_ -notmatch '^[a-z0-9]+(?:-[a-z0-9]+)*$' })
    $profiles = @($roles | ForEach-Object { [string](Get-OptionalProperty $_ 'archetype') } | Where-Object { $_ } | Sort-Object -Unique)
    $declaredProfiles = @((Get-OptionalProperty $organization 'executionProfiles'))
    $navigators = @($roles | Where-Object { (Get-OptionalProperty $_ 'archetype') -eq 'navigator' })
    $navigatorId = [string](Get-OptionalProperty $organization 'navigatorId')
    $contractFailures = @($roles | Where-Object {
      [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $_ 'id')) -or
      [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $_ 'title')) -or
      [string]::IsNullOrWhiteSpace([string](Get-OptionalProperty $_ 'purpose')) -or
      -not (Test-NonEmptyStringList (Get-OptionalProperty $_ 'concreteOutputs')) -or
      -not (Test-NonEmptyStringList (Get-OptionalProperty $_ 'completionContract'))
    })
    $managerialOnly = @($roles | Where-Object {
      (Get-OptionalProperty $_ 'managerialOnly') -eq $true -or
      ([string](Get-OptionalProperty $_ 'roleMode')).ToLowerInvariant() -in @('managerial-only', 'management-only')
    })
    $reportingFailures = @($roles | Where-Object {
      $roleId = [string](Get-OptionalProperty $_ 'id')
      $reportsTo = [string](Get-OptionalProperty $_ 'reportsTo')
      if ($roleId -eq $navigatorId) { return $reportsTo -ne 'operator' }
      return $reportsTo -ne $navigatorId
    })
    $organizationOk = (Get-OptionalProperty $organization 'productName') -eq 'AE Staff' -and
      ([string](Get-OptionalProperty $organization 'workTitle')).StartsWith('Wave 4:') -and
      (Get-OptionalProperty $organization 'structure') -eq 'flat' -and
      [int](Get-OptionalProperty $organization 'roleCount') -eq 50 -and
      [int](Get-OptionalProperty $organization 'logicalActionRoleCount') -eq 50 -and
      [int](Get-OptionalProperty $organization 'executionProfileCount') -eq 7
    $idsOk = $roles.Count -eq 50 -and $ids.Count -eq 50 -and $uniqueIds.Count -eq 50 -and $invalidIds.Count -eq 0
    $profilesOk = (Test-ExactStringSet $profiles $ExecutionProfilePolicy) -and (Test-ExactStringSet $declaredProfiles $ExecutionProfilePolicy)
    $navigatorOk = $navigators.Count -eq 1 -and $navigatorId -and [string](Get-OptionalProperty $navigators[0] 'id') -eq $navigatorId
    $contractsOk = $contractFailures.Count -eq 0 -and $roles.Count -eq 50
    $workingStaffOk = $managerialOnly.Count -eq 0 -and $reportingFailures.Count -eq 0 -and $contractsOk
    $ok = $organizationOk -and $idsOk -and $profilesOk -and $navigatorOk -and $workingStaffOk
    return [ordered]@{
      status = if ($ok) { 'PASS' } else { 'FAIL' }
      ok = $ok
      error = ''
      organization = $organization
      roles = $roles
      profiles = $profiles
      declaredProfiles = $declaredProfiles
      navigators = $navigators
      navigatorId = $navigatorId
      organizationOk = $organizationOk
      idsOk = $idsOk
      profilesOk = $profilesOk
      navigatorOk = $navigatorOk
      contractsOk = $contractsOk
      workingStaffOk = $workingStaffOk
      contractFailures = $contractFailures
      managerialOnly = $managerialOnly
      reportingFailures = $reportingFailures
    }
  } catch {
    return [ordered]@{ status = 'FAIL'; ok = $false; error = $_.Exception.Message; organization = $null; roles = @(); profiles = @(); declaredProfiles = @(); navigators = @(); navigatorId = ''; organizationOk = $false; idsOk = $false; profilesOk = $false; navigatorOk = $false; contractsOk = $false; workingStaffOk = $false; contractFailures = @(); managerialOnly = @(); reportingFailures = @() }
  }
}

$RosterAssessment = Get-AeStaffRosterAssessment $StaffRosterPath
$LogicalRoles = @($RosterAssessment.roles)
if ($RosterAssessment.profilesOk) { $ExpectedProfiles = @($RosterAssessment.profiles) }
if ($RosterAssessment.navigatorOk) {
  $NavigatorRoleId = [string]$RosterAssessment.navigatorId
  $NavigatorProfile = [string](Get-OptionalProperty $RosterAssessment.navigators[0] 'archetype')
}
$contractFailureIds = @($RosterAssessment.contractFailures | ForEach-Object { [string](Get-OptionalProperty $_ 'id') })
$managerialOnlyIds = @($RosterAssessment.managerialOnly | ForEach-Object { [string](Get-OptionalProperty $_ 'id') })
$reportingFailureIds = @($RosterAssessment.reportingFailures | ForEach-Object { [string](Get-OptionalProperty $_ 'id') })
Add-Check 'ae-staff-wave4-roster-contract' $RosterAssessment.status "roles=$($LogicalRoles.Count);organization=$($RosterAssessment.organizationOk);uniqueIds=$($RosterAssessment.idsOk);contracts=$($RosterAssessment.contractsOk);error=$($RosterAssessment.error)"
Add-Check 'ae-staff-wave4-seven-profile-mapping' $(if ($RosterAssessment.profilesOk) { 'PASS' } else { $RosterAssessment.status }) "mapped=$(@($RosterAssessment.profiles) -join ',');expected=$($ExecutionProfilePolicy -join ',')"
Add-Check 'ae-staff-wave4-single-navigator' $(if ($RosterAssessment.navigatorOk) { 'PASS' } else { $RosterAssessment.status }) "roleId=$NavigatorRoleId;profile=$NavigatorProfile;count=$(@($RosterAssessment.navigators).Count)"
Add-Check 'ae-staff-wave4-role-contracts' $(if ($RosterAssessment.contractsOk) { 'PASS' } else { $RosterAssessment.status }) $(if ($contractFailureIds.Count) { $contractFailureIds -join ',' } else { 'all-50-have-concrete-outputs-and-completion-contracts' })
$rosterStructure = [string](Get-OptionalProperty $RosterAssessment.organization 'structure')
Add-Check 'ae-staff-wave4-no-managerial-only-roles' $(if ($RosterAssessment.workingStaffOk) { 'PASS' } else { $RosterAssessment.status }) "managerialOnly=$($managerialOnlyIds -join ',');reportingFailures=$($reportingFailureIds -join ',');structure=$rosterStructure"
$permissionMappingFailures = @($LogicalRoles | Where-Object {
  $profile = [string](Get-OptionalProperty $_ 'archetype')
  -not $ExpectedProfileTools.ContainsKey($profile) -or -not $ExpectedProfileNativeToolsets.ContainsKey($profile)
})
Add-Check 'ae-staff-wave4-profile-permission-mapping' $(if ($permissionMappingFailures.Count -eq 0 -and $LogicalRoles.Count -eq 50) { 'PASS' } else { $RosterAssessment.status }) $(if ($permissionMappingFailures.Count) { @($permissionMappingFailures | ForEach-Object { Get-OptionalProperty $_ 'id' }) -join ',' } else { '50-logical-roles-map-to-seven-profile-permission-sets' })

function Get-ProcessOwnerIdentity([object]$Process) {
  try {
    $sidResult = Invoke-CimMethod -InputObject $Process -MethodName GetOwnerSid -ErrorAction Stop
    $ownerResult = Invoke-CimMethod -InputObject $Process -MethodName GetOwner -ErrorAction Stop
    $sid = if ($sidResult -and $sidResult.ReturnValue -eq 0) { [string]$sidResult.Sid } else { '' }
    $name = if ($ownerResult -and $ownerResult.ReturnValue -eq 0) { "$($ownerResult.Domain)\$($ownerResult.User)" } else { 'unknown' }
    return [ordered]@{ ok = [bool]$sid; sid = $sid; name = $name }
  } catch {
    return [ordered]@{ ok = $false; sid = ''; name = 'unknown'; error = $_.Exception.Message }
  }
}

function Resolve-ProcessChain([object[]]$Processes, [int]$LeafProcessId, [int]$RootProcessId) {
  $chain = New-Object Collections.Generic.List[object]
  $seen = @{}
  $currentId = $LeafProcessId
  while ($currentId -gt 0) {
    if ($seen.ContainsKey($currentId)) {
      return [ordered]@{ ok = $false; reason = "process-chain-cycle=$currentId"; processes = $chain.ToArray(); ids = @($chain | ForEach-Object { [int]$_.ProcessId }) }
    }
    $seen[$currentId] = $true
    $matches = @($Processes | Where-Object { [int]$_.ProcessId -eq $currentId })
    if ($matches.Count -ne 1) {
      return [ordered]@{ ok = $false; reason = "process-chain-node-count=$($matches.Count);pid=$currentId"; processes = $chain.ToArray(); ids = @($chain | ForEach-Object { [int]$_.ProcessId }) }
    }
    $current = $matches[0]
    $chain.Add($current)
    if ($currentId -eq $RootProcessId) {
      return [ordered]@{ ok = $true; reason = 'launch-root-reached'; processes = $chain.ToArray(); ids = @($chain | ForEach-Object { [int]$_.ProcessId }) }
    }
    $currentId = [int]$current.ParentProcessId
  }
  return [ordered]@{ ok = $false; reason = "launch-root-not-reached=$RootProcessId"; processes = $chain.ToArray(); ids = @($chain | ForEach-Object { [int]$_.ProcessId }) }
}

function Test-ProcessChainOwners([object[]]$Chain, [string]$CurrentUserSid, [scriptblock]$OwnerResolver = $null) {
  if (-not $OwnerResolver) { $OwnerResolver = { param($Candidate) Get-ProcessOwnerIdentity $Candidate } }
  $allowedSids = @($CurrentUserSid, 'S-1-5-18') | Where-Object { $_ } | Sort-Object -Unique
  $identities = New-Object Collections.Generic.List[object]
  foreach ($process in $Chain) {
    $identity = & $OwnerResolver $process
    $identities.Add([ordered]@{ pid = [int]$process.ProcessId; ok = [bool]$identity.ok; sid = [string]$identity.sid; name = [string]$identity.name })
  }
  $bad = @($identities | Where-Object { -not $_.ok -or $_.sid -notin $allowedSids })
  return [ordered]@{ ok = $bad.Count -eq 0; identities = $identities.ToArray(); allowedSids = $allowedSids; bad = $bad }
}

function Get-ListenerOwnerAssessment(
  [object[]]$Listeners,
  [object[]]$Processes,
  [object]$Launch,
  [string]$CurrentUserSid,
  [scriptblock]$OwnerResolver = $null
) {
  $listenerArray = @($Listeners)
  if ($listenerArray.Count -eq 0) {
    return [ordered]@{ status = 'BLOCKED'; reason = 'port-8642-not-listening' }
  }
  if ($listenerArray.Count -ne 1) {
    return [ordered]@{ status = 'FAIL'; reason = "listener-count=$($listenerArray.Count)" }
  }

  $listener = $listenerArray[0]
  if ([string]$listener.LocalAddress -ne '127.0.0.1') {
    return [ordered]@{ status = 'FAIL'; reason = "listener-address=$($listener.LocalAddress)"; listener = $listener }
  }
  $ownerPid = [int]$listener.OwningProcess
  $ownerProcesses = @($Processes | Where-Object { [int]$_.ProcessId -eq $ownerPid })
  if ($ownerProcesses.Count -ne 1) {
    return [ordered]@{ status = 'FAIL'; reason = "listener-owner-process-count=$($ownerProcesses.Count);pid=$ownerPid"; listener = $listener }
  }
  if (-not $Launch) {
    return [ordered]@{ status = 'FAIL'; reason = 'listener-running-without-owned-launch-manifest'; listener = $listener; process = $ownerProcesses[0] }
  }
  $launchPid = Get-OptionalProperty $Launch 'pid'
  if (-not $launchPid) {
    return [ordered]@{ status = 'FAIL'; reason = 'launch-manifest-pid-missing'; listener = $listener; process = $ownerProcesses[0] }
  }

  $chain = Resolve-ProcessChain $Processes $ownerPid ([int]$launchPid)
  if (-not $chain.ok) {
    $launchStartRaw = Get-OptionalProperty $Launch 'startTime'
    $processStartRaw = Get-OptionalProperty $ownerProcesses[0] 'CreationDate'
    if (-not $launchStartRaw -or -not $processStartRaw) {
      return [ordered]@{ status = 'FAIL'; reason = $chain.reason; listener = $listener; process = $ownerProcesses[0]; chain = $chain }
    }
    try {
      $launchStart = [DateTimeOffset]::Parse([string]$launchStartRaw).ToUniversalTime()
      $processStart = ([DateTimeOffset]([DateTime]$processStartRaw)).ToUniversalTime()
    } catch {
      return [ordered]@{ status = 'FAIL'; reason = "detached-process-time-unreadable=$($_.Exception.Message)"; listener = $listener; process = $ownerProcesses[0]; chain = $chain }
    }
    if ($processStart -lt $launchStart -or $processStart -gt $launchStart.AddMinutes(15)) {
      return [ordered]@{ status = 'FAIL'; reason = "detached-process-time-outside-launch-window;launch=$($launchStart.ToString('o'));process=$($processStart.ToString('o'))"; listener = $listener; process = $ownerProcesses[0]; chain = $chain }
    }
    $detachedOwners = Test-ProcessChainOwners @($ownerProcesses[0]) $CurrentUserSid $OwnerResolver
    if (-not $detachedOwners.ok) {
      $badOwners = @($detachedOwners.bad | ForEach-Object { "$($_.pid):$($_.sid)" }) -join ','
      return [ordered]@{ status = 'FAIL'; reason = "untrusted-detached-listener-owner=$badOwners"; listener = $listener; process = $ownerProcesses[0]; chain = $chain; owners = $detachedOwners }
    }
    $detachedChain = [ordered]@{
      ok = $true
      reason = "launch-wrapper-exited;$($chain.reason)"
      processes = @($ownerProcesses[0])
      ids = @($ownerPid)
      detached = $true
      launchStart = $launchStart.ToString('o')
      processStart = $processStart.ToString('o')
    }
    return [ordered]@{ status = 'PASS'; reason = 'single-owned-loopback-listener-detached-entrypoint'; listener = $listener; process = $ownerProcesses[0]; chain = $detachedChain; owners = $detachedOwners }
  }
  $owners = Test-ProcessChainOwners $chain.processes $CurrentUserSid $OwnerResolver
  if (-not $owners.ok) {
    $badOwners = @($owners.bad | ForEach-Object { "$($_.pid):$($_.sid)" }) -join ','
    return [ordered]@{ status = 'FAIL'; reason = "untrusted-process-chain-owner=$badOwners"; listener = $listener; process = $ownerProcesses[0]; chain = $chain; owners = $owners }
  }
  return [ordered]@{ status = 'PASS'; reason = 'single-owned-loopback-listener'; listener = $listener; process = $ownerProcesses[0]; chain = $chain; owners = $owners }
}

function Test-SecretAcl([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return [ordered]@{ ok = $false; evidence = "missing=$Path" } }
  try {
    $acl = Get-Acl -LiteralPath $Path
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $systemSid = [Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    $ownerSid = ([Security.Principal.NTAccount]$acl.Owner).Translate([Security.Principal.SecurityIdentifier])
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    $expected = @([string]$currentSid.Value, [string]$systemSid.Value)
    $actual = @($rules | ForEach-Object { [string]$_.IdentityReference.Value } | Sort-Object -Unique)
    $full = [Security.AccessControl.FileSystemRights]::FullControl
    $badRule = @($rules | Where-Object {
      $_.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
      $_.IdentityReference.Value -notin $expected -or
      ($_.FileSystemRights -band $full) -ne $full
    })
    $principalsOk = $actual.Count -eq $expected.Count -and -not (Compare-Object ($actual | Sort-Object) ($expected | Sort-Object))
    $ok = $acl.AreAccessRulesProtected -and $ownerSid.Value -eq $currentSid.Value -and $principalsOk -and $badRule.Count -eq 0
    return [ordered]@{ ok = $ok; evidence = "protected=$($acl.AreAccessRulesProtected);owner=$($ownerSid.Value);principals=$($actual -join ',');badRules=$($badRule.Count)" }
  } catch { return [ordered]@{ ok = $false; evidence = $_.Exception.Message } }
}

function Test-ToolsetSurface([object]$HttpResult, [string[]]$Expected) {
  if ($HttpResult.status -ne 200) { return [ordered]@{ ok = $false; evidence = "status=$($HttpResult.status)" } }
  try {
    $parsed = $HttpResult.response.Content | ConvertFrom-Json
    $items = if ($parsed.data) { @($parsed.data) } else { @($parsed) }
    # Hermes intentionally omits MCP servers from /v1/toolsets. Compare only
    # enabled native toolsets here; MCP configuration is checked separately.
    $normalized = @($items | Where-Object { $_.enabled -eq $true } | ForEach-Object { [string]$_.name } | Sort-Object -Unique)
    $expectedSorted = @($Expected | Sort-Object -Unique)
    $ok = $normalized.Count -eq $expectedSorted.Count -and -not (Compare-Object $normalized $expectedSorted)
    return [ordered]@{ ok = $ok; evidence = "enabledNative=$($normalized -join ',');expected=$($expectedSorted -join ',')" }
  } catch { return [ordered]@{ ok = $false; evidence = $_.Exception.Message } }
}

function Test-ConfiguredMcpSurface([string]$ConfigPath, [string[]]$Expected, [string]$ExpectedUrl) {
  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { return [ordered]@{ ok = $false; evidence = "missing=$ConfigPath" } }
  $text = Get-Content -LiteralPath $ConfigPath -Raw
  $matches = [regex]::Matches($text, 'orange5_(?:health|route|order|receipts|delegate)')
  $configured = @($matches | ForEach-Object { $_.Value } | Sort-Object -Unique)
  $expectedSorted = @($Expected | Sort-Object -Unique)
  $toolsOk = $configured.Count -eq $expectedSorted.Count -and -not (Compare-Object $configured $expectedSorted)
  $urlOk = $text -match [regex]::Escape($ExpectedUrl)
  $enabledOk = $text -match '(?ms)^mcp_servers:.*?^\s{4}enabled:\s*true\s*$'
  $platformOk = $text -match '(?ms)^platform_toolsets:.*?mcp-orange5'
  $ok = $toolsOk -and $urlOk -and $enabledOk -and $platformOk
  return [ordered]@{ ok = $ok; evidence = "mcpTools=$($configured -join ',');expected=$($expectedSorted -join ',');url=$urlOk;enabled=$enabledOk;platform=$platformOk" }
}

$manifest = Join-Path $InstallRoot 'install-manifest.json'
$installed = $null
if (Test-Path -LiteralPath $manifest) {
  $installed = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
  $pinCommit = Get-OptionalProperty $installed 'pinCommit'
  if (-not $pinCommit) { $pinCommit = Get-OptionalProperty $installed 'commit' }
  $provenanceMode = Get-OptionalProperty $installed 'provenanceMode'
  $sourceVerified = [bool](Get-OptionalProperty $installed 'sourceCommitVerified')
  $ok = $installed.version -eq $Lock.packageVersion -and $pinCommit -eq $Lock.commit
  Add-Check 'installed-release-pin' $(if ($ok) { 'PASS' } else { 'FAIL' }) "version=$($installed.version);pinCommit=$pinCommit;mode=$provenanceMode"
  Add-Check 'source-commit-provenance' $(if ($sourceVerified) { 'PASS' } else { 'ADOPTED_BINARY' }) "verified=$sourceVerified;mode=$provenanceMode" $false
} else { Add-Check 'installed-release-pin' 'BLOCKED' "missing=$manifest" }

$manifestExe = Get-OptionalProperty $installed 'hermesExecutable'
$hermes = if ($manifestExe) { [string]$manifestExe } else { Join-Path $InstallRoot 'venv\Scripts\hermes.exe' }
if (Test-Path -LiteralPath $hermes) {
  $versionOutput = (& $hermes --version 2>&1 | Out-String).Trim()
  Add-Check 'hermes-cli' $(if ($versionOutput -match [regex]::Escape($Lock.packageVersion)) { 'PASS' } else { 'FAIL' }) $versionOutput
  $expectedHash = Get-OptionalProperty $installed 'binarySha256'
  $actualHash = (Get-FileHash -LiteralPath $hermes -Algorithm SHA256).Hash.ToLowerInvariant()
  Add-Check 'hermes-binary-integrity' $(if ($expectedHash -and $actualHash -eq $expectedHash) { 'PASS' } else { 'FAIL' }) "expected=$expectedHash;actual=$actualHash"
} else {
  Add-Check 'hermes-cli' 'BLOCKED' "missing=$hermes"
  Add-Check 'hermes-binary-integrity' 'BLOCKED' "missing=$hermes"
}

$missingProfiles = @($ExpectedProfiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $HermesHome "profiles\$_\config.yaml")) })
Add-Check 'isolated-profiles' $(if ($missingProfiles.Count -eq 0) { 'PASS' } else { 'BLOCKED' }) $(if ($missingProfiles.Count) { "missing=$($missingProfiles -join ',')" } else { "count=$($ExpectedProfiles.Count)" })

$ownerConfig = Join-Path $HermesHome 'config.yaml'
$ownerConfigText = if (Test-Path -LiteralPath $ownerConfig) { Get-Content -LiteralPath $ownerConfig -Raw } else { '' }
$allowlistMatch = [regex]::Match($ownerConfigText, '(?ms)^\s{2}multiplex_profile_allowlist:\s*\r?\n(?<items>(?:\s{4}-\s*[^\r\n]+\r?\n)+)')
$ownerAllowlist = if ($allowlistMatch.Success) {
  @([regex]::Matches($allowlistMatch.Groups['items'].Value, '(?m)^\s{4}-\s*(?<profile>[^\s#]+)\s*$') | ForEach-Object { $_.Groups['profile'].Value })
} else { @() }
$ownerAllowlistOk = Test-ExactStringSet $ownerAllowlist $ExpectedProfiles
$ownerConfigOk = $ownerConfigText -match '(?m)^\s*multiplex_profiles:\s*true\s*$' -and
  $ownerConfigText -match '(?m)^\s*dispatch_in_gateway:\s*true\s*$' -and
  $ownerAllowlistOk
$missingNamedConfigs = @($ExpectedProfiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $HermesHome "profiles\$_\config.yaml")) })
$namedConfigBad = @($ExpectedProfiles | Where-Object {
  $path = Join-Path $HermesHome "profiles\$_\config.yaml"
  if (-not (Test-Path -LiteralPath $path)) { return $false }
  $text = Get-Content -LiteralPath $path -Raw
  $sharedListenerOnly = $text -match '(?ms)^platforms:\s*\r?\n\s{2}api_server:\s*\r?\n\s{4}enabled:\s*false\s*$'
  return $text -notmatch '(?m)^\s*multiplex_profiles:\s*false\s*$' -or
    $text -notmatch '(?m)^\s*dispatch_in_gateway:\s*false\s*$' -or
    -not $sharedListenerOnly
})
if (-not (Test-Path -LiteralPath $ownerConfig) -or $missingNamedConfigs.Count) {
  Add-Check 'single-dispatcher-config' 'BLOCKED' "ownerPresent=$(Test-Path -LiteralPath $ownerConfig);missingNamed=$($missingNamedConfigs -join ',')"
} else {
  Add-Check 'single-dispatcher-config' $(if ($ownerConfigOk -and $namedConfigBad.Count -eq 0) { 'PASS' } else { 'FAIL' }) "owner=$ownerConfigOk;allowlist=$($ownerAllowlist -join ',');expected=$($ExpectedProfiles -join ',');badNamed=$($namedConfigBad -join ',')"
}

$launchPath = Join-Path $DataRoot 'gateway-launch.json'
$launch = if (Test-Path -LiteralPath $launchPath) { Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json } else { $null }
$listeners = @(Get-NetTCPConnection -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue)
$allProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$currentUserSid = [string][Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$listenerOwner = Get-ListenerOwnerAssessment $listeners $allProcesses $launch $currentUserSid
if ($listenerOwner.status -eq 'PASS') {
  $process = $listenerOwner.process
  $expectedExeRoot = [IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $hermes))).TrimEnd('\') + '\'
  $directExeOk = $process.ExecutablePath -and [IO.Path]::GetFullPath($process.ExecutablePath).StartsWith($expectedExeRoot, [StringComparison]::OrdinalIgnoreCase)
  $entrypointOk = $process.CommandLine -and $process.CommandLine.IndexOf($hermes, [StringComparison]::OrdinalIgnoreCase) -ge 0
  $exeOk = $directExeOk -or $entrypointOk
  $homeOk = [IO.Path]::GetFullPath([string]$launch.hermesHome) -eq [IO.Path]::GetFullPath($HermesHome)
  $namedProfilePattern = @($ExpectedProfiles | ForEach-Object { [regex]::Escape($_) }) -join '|'
  $namedGateway = @($listenerOwner.chain.processes | Where-Object { $_.CommandLine -match "(?i)(?:--profile|-p)\s+(?:$namedProfilePattern)(?:\s|$)" }).Count -gt 0
  $gatewayCommands = @($listenerOwner.chain.processes | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '(?i)gateway\s+run' -and $_.CommandLine -match '(?i)--external-supervisor'
  })
  $commandOk = $gatewayCommands.Count -gt 0
  $launchHash = Get-OptionalProperty $launch 'binarySha256'
  $currentHash = if (Test-Path -LiteralPath $hermes) { (Get-FileHash -LiteralPath $hermes -Algorithm SHA256).Hash.ToLowerInvariant() } else { '' }
  $launchHashOk = $launchHash -and $launchHash -eq $currentHash
  $gatewayOk = $exeOk -and $homeOk -and -not $namedGateway -and $commandOk -and $launchHashOk
  $chainIds = @($listenerOwner.chain.ids) -join '>'
  $chainOwners = @($listenerOwner.owners.identities | ForEach-Object { "$($_.pid):$($_.sid)" }) -join ','
  $detached = [bool](Get-OptionalProperty $listenerOwner.chain 'detached')
  Add-Check 'single-gateway-owner' $(if ($gatewayOk) { 'PASS' } else { 'FAIL' }) "listenerPid=$($process.ProcessId);launchPid=$($launch.pid);chain=$chainIds;detached=$detached;exe=$exeOk;entrypoint=$entrypointOk;home=$homeOk;named=$namedGateway;command=$commandOk;owners=$chainOwners;hash=$launchHashOk"
  Add-Check 'api-listener-owner-bind' 'PASS' "address=$($listenerOwner.listener.LocalAddress);pid=$($listenerOwner.listener.OwningProcess);chain=$chainIds"
} elseif ($listenerOwner.status -eq 'BLOCKED') {
  Add-Check 'single-gateway-owner' 'BLOCKED' 'gateway-not-running'
  Add-Check 'api-listener-owner-bind' 'BLOCKED' $listenerOwner.reason
} else {
  Add-Check 'single-gateway-owner' 'FAIL' $listenerOwner.reason
  Add-Check 'api-listener-owner-bind' 'FAIL' $listenerOwner.reason
}

$board = Join-Path $HermesHome 'kanban.db'
if (Test-Path -LiteralPath $board) {
  $adoptedPython = if ($hermes) { Join-Path (Split-Path -Parent $hermes) 'python.exe' } else { '' }
  $managedPython = Join-Path $InstallRoot 'venv\Scripts\python.exe'
  $python = if ($adoptedPython -and (Test-Path -LiteralPath $adoptedPython -PathType Leaf)) { $adoptedPython } else { $managedPython }
  if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    Add-Check 'durable-kanban-board' 'BLOCKED' "python-missing=$python;board=$board"
  } else {
    $integrity = (& $python -c "import sqlite3; c=sqlite3.connect(r'$board'); print(c.execute('pragma integrity_check').fetchone()[0]); c.close()" 2>&1 | Out-String).Trim()
    Add-Check 'durable-kanban-board' $(if ($integrity -eq 'ok') { 'PASS' } else { 'FAIL' }) "path=$board;integrity=$integrity"
  }
} else { Add-Check 'durable-kanban-board' 'BLOCKED' "missing=$board" }

$mcpHealthUrl = $OrangeMcpUrl -replace '/mcp/?$', '/health'
try {
  $mcpHealth = Invoke-RestMethod -Uri $mcpHealthUrl -TimeoutSec 5
  $mcpOk = $mcpHealth.ok -eq $true -and $mcpHealth.transport -eq 'streamable-http' -and $mcpHealth.endpoint -eq '/mcp'
  Add-Check 'orange-brain-mcp' $(if ($mcpOk) { 'PASS' } else { 'FAIL' }) "url=$OrangeMcpUrl;protocol=$($mcpHealth.protocol);transport=$($mcpHealth.transport)"
} catch { Add-Check 'orange-brain-mcp' 'BLOCKED' "url=$OrangeMcpUrl;error=$($_.Exception.Message)" }

try {
  $staffHealth = Invoke-RestMethod -Uri "$($StaffReactorUrl.TrimEnd('/'))/health" -TimeoutSec 5
  $activeActors = [int]$staffHealth.readyCount + [int]$staffHealth.runningCount
  $staffLive = $staffHealth.ok -eq $true -and
    $staffHealth.schema -eq 'orange.hermes-staff-reactor.v1' -and
    $staffHealth.status -eq 'LIVE' -and
    [int]$staffHealth.roleCount -eq 50 -and
    $activeActors -eq 50 -and
    [int]$staffHealth.inferenceLimit -gt 0 -and
    [int]$staffHealth.inferenceLimit -lt 50
  Add-Check 'ae-staff-wave4-live-actors' $(if ($staffLive) { 'PASS' } else { 'FAIL' }) "url=$StaffReactorUrl;status=$($staffHealth.status);roles=$($staffHealth.roleCount);active=$activeActors;inferenceLimit=$($staffHealth.inferenceLimit)"
} catch {
  Add-Check 'ae-staff-wave4-live-actors' 'BLOCKED' "url=$StaffReactorUrl;error=$($_.Exception.Message)"
}

$ownerEnv = Join-Path $HermesHome '.env'
$apiKey = $null
if (Test-Path -LiteralPath $ownerEnv) {
  $keyLine = Get-Content -LiteralPath $ownerEnv | Where-Object { $_ -match '^API_SERVER_KEY=' } | Select-Object -First 1
  if ($keyLine) { $apiKey = $keyLine.Split('=', 2)[1] }
}
$profileKeys = @{}
$secretPaths = @($ownerEnv)
foreach ($profile in $ExpectedProfiles) {
  $profileEnv = Join-Path $HermesHome "profiles\$profile\.env"
  $secretPaths += $profileEnv
  if (Test-Path -LiteralPath $profileEnv) {
    $profileKeyLine = Get-Content -LiteralPath $profileEnv | Where-Object { $_ -match '^API_SERVER_KEY=' } | Select-Object -First 1
    if ($profileKeyLine) { $profileKeys[$profile] = $profileKeyLine.Split('=', 2)[1] }
  }
}

$aclResults = @($secretPaths | ForEach-Object { $result = Test-SecretAcl $_; [ordered]@{ path = $_; ok = $result.ok; evidence = $result.evidence } })
$aclMissing = @($aclResults | Where-Object { $_.evidence -like 'missing=*' })
$aclBad = @($aclResults | Where-Object { -not $_.ok })
$aclStatus = if ($aclMissing.Count) { 'BLOCKED' } elseif ($aclBad.Count) { 'FAIL' } else { 'PASS' }
Add-Check 'secret-file-acls' $aclStatus $(if ($aclBad.Count) { ($aclBad | ForEach-Object { "$($_.path):$($_.evidence)" }) -join ';' } else { "files=$($aclResults.Count)" })

$allKeys = @($apiKey) + @($profileKeys.Values)
$nonEmptyKeys = @($allKeys | Where-Object { $_ })
$uniqueKeys = @($nonEmptyKeys | Sort-Object -Unique)
$keysDistinct = $nonEmptyKeys.Count -eq ($ExpectedProfiles.Count + 1) -and $uniqueKeys.Count -eq $nonEmptyKeys.Count
Add-Check 'profile-api-keys-distinct' $(if ($keysDistinct) { 'PASS' } elseif ($aclMissing.Count) { 'BLOCKED' } else { 'FAIL' }) "present=$($nonEmptyKeys.Count);unique=$($uniqueKeys.Count);expected=$($ExpectedProfiles.Count + 1)"

$inferenceRequests = 0
if ($apiKey) {
  $positive = Get-HttpStatus 'http://127.0.0.1:8642/v1/capabilities' @{ Authorization = "Bearer $apiKey" }
  $noAuth = Get-HttpStatus 'http://127.0.0.1:8642/v1/capabilities'
  $wrongAuth = Get-HttpStatus 'http://127.0.0.1:8642/v1/capabilities' @{ Authorization = 'Bearer orange5-intentionally-wrong' }
  $cors = if ($positive.response) { [string]$positive.response.Headers['Access-Control-Allow-Origin'] } else { '' }
  $apiOk = $positive.status -eq 200 -and $noAuth.status -in @(401, 403) -and $wrongAuth.status -in @(401, 403) -and -not $cors
  Add-Check 'openai-loopback-api' $(if ($apiOk) { 'PASS' } else { 'FAIL' }) "positive=$($positive.status);noAuth=$($noAuth.status);wrongAuth=$($wrongAuth.status);cors=$(if ($cors) { 'present' } else { 'absent' })"

  if ($positive.status -eq 200) {
    $toolsetResponse = Get-HttpStatus 'http://127.0.0.1:8642/v1/toolsets' @{ Authorization = "Bearer $apiKey" } 15
    $ownerNativeSurface = Test-ToolsetSurface $toolsetResponse $ExpectedNativeToolsets
    $ownerMcpSurface = Test-ConfiguredMcpSurface (Join-Path $HermesHome 'config.yaml') $ExpectedMcpTools $OrangeMcpUrl
    $ownerSurfaceOk = $ownerNativeSurface.ok -and $ownerMcpSurface.ok
    Add-Check 'hermes-filtered-mcp-surface' $(if ($ownerSurfaceOk) { 'PASS' } else { 'FAIL' }) "$($ownerNativeSurface.evidence);$($ownerMcpSurface.evidence)"
  } else { Add-Check 'hermes-filtered-mcp-surface' 'BLOCKED' 'api-not-ready' }

  $profileFailures = @()
  $surfaceFailures = @()
  $crossAuthFailures = @()
  for ($index = 0; $index -lt $ExpectedProfiles.Count; $index++) {
    $profile = $ExpectedProfiles[$index]
    if (-not $profileKeys.ContainsKey($profile)) { $profileFailures += "${profile}:key-missing"; continue }
    $profileKey = $profileKeys[$profile]
    $probeProfile = Get-HttpStatus "http://127.0.0.1:8642/p/$profile/v1/models" @{ Authorization = "Bearer $profileKey" }
    if ($probeProfile.status -ne 200) { $profileFailures += "${profile}:$($probeProfile.status)" }
    $profileToolsets = Get-HttpStatus "http://127.0.0.1:8642/p/$profile/v1/toolsets" @{ Authorization = "Bearer $profileKey" } 15
    $profileNativeSurface = Test-ToolsetSurface $profileToolsets $ExpectedProfileNativeToolsets[$profile]
    $profileMcpSurface = Test-ConfiguredMcpSurface (Join-Path $HermesHome "profiles\$profile\config.yaml") $ExpectedProfileTools[$profile] $OrangeMcpUrl
    if (-not ($profileNativeSurface.ok -and $profileMcpSurface.ok)) { $surfaceFailures += "${profile}:$($profileNativeSurface.evidence);$($profileMcpSurface.evidence)" }

    $otherProfile = $ExpectedProfiles[($index + 1) % $ExpectedProfiles.Count]
    if ($profileKeys.ContainsKey($otherProfile)) {
      $crossKey = $profileKeys[$otherProfile]
      $crossProbe = Get-HttpStatus "http://127.0.0.1:8642/p/$profile/v1/models" @{ Authorization = "Bearer $crossKey" }
      if ($crossProbe.status -notin @(401, 403)) { $crossAuthFailures += "${otherProfile}->${profile}:$($crossProbe.status)" }
    }
    $ownerOnProfile = Get-HttpStatus "http://127.0.0.1:8642/p/$profile/v1/models" @{ Authorization = "Bearer $apiKey" }
    if ($ownerOnProfile.status -notin @(401, 403)) { $crossAuthFailures += "owner->${profile}:$($ownerOnProfile.status)" }
  }
  Add-Check 'multiplex-profile-api-routes' $(if ($profileFailures.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($profileFailures.Count) { $profileFailures -join ',' } else { "profiles=$($ExpectedProfiles.Count)" })
  Add-Check 'profile-filtered-mcp-surfaces' $(if ($surfaceFailures.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($surfaceFailures.Count) { $surfaceFailures -join ';' } else { "profiles=$($ExpectedProfiles.Count)" })
  Add-Check 'cross-profile-auth-rejection' $(if ($crossAuthFailures.Count -eq 0 -and $keysDistinct) { 'PASS' } else { 'FAIL' }) $(if ($crossAuthFailures.Count) { $crossAuthFailures -join ',' } else { 'owner-and-peer-keys-rejected' })

  if ($ProbeAgentInference) {
    if (-not $RosterAssessment.ok) {
      Add-Check 'ae-staff-wave4-navigator-inference' 'BLOCKED' 'roster-contract-not-ready;inference-not-sent'
    } elseif ($surfaceFailures.Count -gt 0) {
      Add-Check 'ae-staff-wave4-navigator-inference' 'BLOCKED' 'filtered-profile-surface-not-ready;inference-not-sent'
    } elseif (-not $profileKeys.ContainsKey($NavigatorProfile)) {
      Add-Check 'ae-staff-wave4-navigator-inference' 'BLOCKED' "navigator-profile-key-missing=$NavigatorProfile;inference-not-sent"
    } else {
      $nonce = "HERMES_CODEXA_PROOF_$([Guid]::NewGuid().ToString('N').Substring(0, 12).ToUpperInvariant())"
      $agentHeaders = @{
        Authorization = "Bearer $($profileKeys[$NavigatorProfile])"
        'Content-Type' = 'application/json'
        'X-Hermes-Session-Id' = "preflight-$([Guid]::NewGuid().ToString('N'))"
        'X-Hermes-Session-Key' = 'ae-staff-wave4-preflight'
      }
      $agentBody = [ordered]@{
        model = $NavigatorProfile
        messages = @(@{ role = 'user'; content = "Reply with exactly $nonce and nothing else. Do not use tools." })
        max_tokens = 64
        temperature = 0
        stream = $false
      } | ConvertTo-Json -Depth 8 -Compress
      $agentStarted = Get-Date
      try {
        $inferenceRequests += 1
        $agentResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8642/p/$NavigatorProfile/v1/chat/completions" -Method Post -Headers $agentHeaders -Body $agentBody -TimeoutSec $AgentInferenceTimeoutSec
        $agentParsed = $agentResponse.Content | ConvertFrom-Json
        $agentContent = [string]$agentParsed.choices[0].message.content
        $agentLatencyMs = [int]((Get-Date) - $agentStarted).TotalMilliseconds
        $containsNonce = $agentContent -match [regex]::Escape($nonce)
        $validOrangeReport = $false
        try {
          $compiled = $agentContent | ConvertFrom-Json
          $validOrangeReport = $compiled.schema -eq 'orange.report.v1' -and
            -not [string]::IsNullOrWhiteSpace([string]$compiled.orderId) -and
            -not [string]::IsNullOrWhiteSpace([string]$compiled.status) -and
            $null -ne $compiled.actionsTaken -and $null -ne $compiled.evidence -and
            $null -ne $compiled.blockers -and -not [string]::IsNullOrWhiteSpace([string]$compiled.nextAction)
        } catch { $validOrangeReport = $false }
        $agentOk = $agentResponse.StatusCode -eq 200 -and ($containsNonce -or $validOrangeReport)
        Add-Check 'ae-staff-wave4-navigator-inference' $(if ($agentOk -and $inferenceRequests -eq 1) { 'PASS' } else { 'FAIL' }) "roleId=$NavigatorRoleId;profile=$NavigatorProfile;requests=$inferenceRequests;status=$($agentResponse.StatusCode);model=$($agentParsed.model);containsNonce=$containsNonce;validOrangeReport=$validOrangeReport;latencyMs=$agentLatencyMs"
      } catch {
        $agentLatencyMs = [int]((Get-Date) - $agentStarted).TotalMilliseconds
        Add-Check 'ae-staff-wave4-navigator-inference' 'FAIL' "roleId=$NavigatorRoleId;profile=$NavigatorProfile;requests=$inferenceRequests;error=$($_.Exception.Message);latencyMs=$agentLatencyMs"
      }
    }
  } else {
    Add-Check 'ae-staff-wave4-navigator-inference' 'SKIPPED' "roleId=$NavigatorRoleId;profile=$NavigatorProfile;requests=0;enable-with=-ProbeAgentInference" $false
  }
} else {
  Add-Check 'openai-loopback-api' 'BLOCKED' 'runtime-api-key-missing'
  Add-Check 'hermes-filtered-mcp-surface' 'BLOCKED' 'runtime-api-key-missing'
  Add-Check 'multiplex-profile-api-routes' 'BLOCKED' 'runtime-api-key-missing'
  Add-Check 'profile-filtered-mcp-surfaces' 'BLOCKED' 'runtime-api-key-missing'
  Add-Check 'cross-profile-auth-rejection' 'BLOCKED' 'runtime-api-key-missing'
  Add-Check 'ae-staff-wave4-navigator-inference' 'BLOCKED' "roleId=$NavigatorRoleId;profile=$NavigatorProfile;requests=0;runtime-api-key-missing" ([bool]$ProbeAgentInference)
}

try {
  $models = Invoke-RestMethod -Uri "$($OrangeModelUrl.TrimEnd('/'))/models" -TimeoutSec 5
  $count = @($models.data).Count
  Add-Check 'orange-model-endpoint' $(if ($count -gt 0) { 'PASS' } else { 'FAIL' }) "url=$OrangeModelUrl;models=$count"
} catch { Add-Check 'orange-model-endpoint' 'BLOCKED' "model-endpoint-unreachable=$($_.Exception.Message)" }

$requiredBad = @($Checks | Where-Object { $_.required -and $_.status -ne 'PASS' })
$overall = if ($requiredBad.Count -eq 0) { 'READY' } else { 'NOT_READY' }
$report = [ordered]@{
  schema = 'orange5.hermes-preflight.v1'
  createdAt = (Get-Date).ToUniversalTime().ToString('o')
  status = $overall
  pinnedVersion = $Lock.packageVersion
  pinnedCommit = $Lock.commit
  aeStaff = [ordered]@{
    wave = 4
    productName = 'AE Staff'
    rosterPath = $StaffRosterPath
    logicalRoleCount = $LogicalRoles.Count
    executionProfiles = $ExpectedProfiles
    navigatorRoleId = $NavigatorRoleId
    navigatorProfile = $NavigatorProfile
    staffReactorUrl = $StaffReactorUrl
    inferenceRequests = $inferenceRequests
  }
  checks = $Checks
  blockers = @($requiredBad | ForEach-Object { $_.name })
  receiptPath = $null
}

if ($WriteReceipt) {
  $receiptRoot = Join-Path $DataRoot 'receipts'
  New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
  $receipt = Join-Path $receiptRoot "hermes-product-preflight-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')).json"
  $report.receiptPath = $receipt
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $receipt -Encoding utf8
}

$report | ConvertTo-Json -Depth 12
if ($overall -ne 'READY') { exit 1 }
