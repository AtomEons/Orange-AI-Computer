[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Role,
  [switch]$Execute,
  [string]$Manifest = (Join-Path $PSScriptRoot 'captain-planet-stack.json'),
  [string]$Worker = 'CODEXA',
  [string]$SshKey = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519')
)

$ErrorActionPreference = 'Stop'
$registry = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$route = @($registry.roles | Where-Object role -eq $Role)
if ($route.Count -ne 1) { throw "Unknown or duplicate creative route: $Role" }
$route = $route[0]

if (-not $Execute) {
  & bun (Join-Path $PSScriptRoot 'captain-planet-governor.mjs') dry-run $Role
  exit $LASTEXITCODE
}

if (-not $route.availability.lease_eligible) {
  & bun (Join-Path $PSScriptRoot 'captain-planet-governor.mjs') lease $Role
  exit 1
}
if (-not $route.activation.source_script) { throw "Lease-eligible route lacks a source runner: $Role" }

$repositoryRoot = Split-Path $PSScriptRoot -Parent
$sourceScript = Join-Path $repositoryRoot ([string]$route.activation.source_script)
$leaseHost = Join-Path $PSScriptRoot 'codexa-creative-lease.ps1'
if (-not (Test-Path -LiteralPath $sourceScript -PathType Leaf)) { throw "Source runner missing: $sourceScript" }
if (-not (Test-Path -LiteralPath $leaseHost -PathType Leaf)) { throw "Codexa lease host missing: $leaseHost" }
if (-not (Test-Path -LiteralPath $SshKey -PathType Leaf)) { throw "SSH key missing: $SshKey" }

$remoteRoot = 'C:/AtomEons/ai-box/creative/runners'
$remoteManifest = "$remoteRoot/captain-planet-stack.json"
$remoteLeaseHost = "$remoteRoot/codexa-creative-lease.ps1"
$remoteScript = [string]$route.activation.remote_script
$target = "$($registry.hosts.worker_user)@$Worker"
$sshBase = @('-o','BatchMode=yes','-o','ConnectTimeout=10','-i',$SshKey,$target)

& ssh @sshBase powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Force -Path '$remoteRoot' | Out-Null"
if ($LASTEXITCODE -ne 0) { throw 'Codexa runner staging directory failed' }

& scp -q -i $SshKey $Manifest ("{0}:{1}" -f $target,$remoteManifest)
if ($LASTEXITCODE -ne 0) { throw 'Captain Planet registry staging failed' }
& scp -q -i $SshKey $leaseHost ("{0}:{1}" -f $target,$remoteLeaseHost)
if ($LASTEXITCODE -ne 0) { throw 'Codexa lease host staging failed' }
& scp -q -i $SshKey $sourceScript ("{0}:{1}" -f $target,$remoteScript)
if ($LASTEXITCODE -ne 0) { throw 'Creative source runner staging failed' }

$arguments = @($remoteScript) + @($route.activation.arguments)
$argumentsJson = $arguments | ConvertTo-Json -Compress
$argumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argumentsJson))
$remoteOutput = @(& ssh @sshBase powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $remoteLeaseHost -Manifest $remoteManifest -Role $Role -Executable ([string]$route.activation.remote_python) -ArgumentsBase64 $argumentsBase64)
$remoteExit = $LASTEXITCODE

$receiptRoot = Join-Path $PSScriptRoot 'receipts'
New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$receiptPath = Join-Path $receiptRoot ("{0}-{1}-activation.json" -f ((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fffZ')), $Role)
$receipt = [ordered]@{
  schema = 'orange.creative-route-activation.v1'
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  role = $Role
  model = $route.model
  worker = $Worker
  execution_performed = $true
  remote_exit_code = $remoteExit
  remote_output = $remoteOutput
  artifact_proof_required = $true
}
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
$remoteOutput
Write-Host "activation_receipt=$receiptPath"
exit $remoteExit
