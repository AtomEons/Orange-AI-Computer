[CmdletBinding()]
param([switch]$SkipDatasetUpload)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataset = Join-Path $here 'kaggle-dataset'
$kernel = Join-Path $here 'kaggle-kernel'
$token = [Environment]::GetEnvironmentVariable('KAGGLE_API_TOKEN', 'User')
if ([string]::IsNullOrWhiteSpace($token)) { throw 'KAGGLE_API_TOKEN is not configured in the user environment' }
$env:KAGGLE_API_TOKEN = $token

& bun (Join-Path $here 'build-trainset.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Orange compliance trainset build failed' }
if (-not $SkipDatasetUpload) {
  & kaggle datasets create -p $dataset -r zip
  if ($LASTEXITCODE -ne 0) { throw 'Kaggle private dataset upload failed' }
}
& kaggle kernels push -p $kernel
if ($LASTEXITCODE -ne 0) { throw 'Kaggle training kernel launch failed' }
Write-Output 'ORANGE_NAVIGATOR_KAGGLE_TRAINING_SUBMITTED'
