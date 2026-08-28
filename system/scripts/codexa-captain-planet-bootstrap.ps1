[CmdletBinding()]
param(
  [string]$Root = 'C:\AtomEons\ai-box\creative',
  [switch]$InstallEnvironments,
  [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Resolve-RequiredCommand([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "Required command not found: $Name" }
  return $command.Source
}

function Sync-Repository([string]$Name, [string]$Url, [string]$ExpectedCommit) {
  $target = Join-Path $Root $Name
  $sourceState = 'git_checkout'
  $gitCommit = $null
  if (Test-Path (Join-Path $target '.git')) {
    $previousErrorAction = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'SilentlyContinue'
      $gitCommitText = (& $script:Git -C $target rev-parse HEAD 2>$null) -join ''
      $gitProbeExit = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorAction
    }
    if ($gitProbeExit -eq 0 -and $gitCommitText) { $gitCommit = $gitCommitText.Trim() }
  }
  if ($gitCommit) {
    if (-not $Offline) {
      & $script:Git -C $target pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "Repository sync failed: $Name" }
      $gitCommit = ((& $script:Git -C $target rev-parse HEAD) -join '').Trim()
    }
  } else {
    if ($Offline) {
      if (-not (Test-Path -LiteralPath $target)) { throw "Offline source missing: $target" }
      if (-not $ExpectedCommit) { throw "Offline snapshot lacks expected commit: $Name" }
      $sourceState = 'offline_verified_snapshot'
    } else {
      & $script:Git clone --depth 1 $Url $target
      if ($LASTEXITCODE -ne 0) { throw "Repository sync failed: $Name" }
    }
  }
  $commit = if ($gitCommit) { $gitCommit } else { $ExpectedCommit }
  if ($ExpectedCommit -and $commit -ne $ExpectedCommit) {
    throw "Source commit mismatch for ${Name}: expected=$ExpectedCommit actual=$commit"
  }
  return [ordered]@{
    name = $Name
    path = $target
    url = $Url
    commit = $commit
    source_state = $sourceState
    artifact_proof_required = $true
  }
}

function New-UvEnvironment([string]$Repo, [string]$Python = '3.12') {
  $venv = Join-Path $Repo '.venv'
  if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
    & $script:Uv venv --python $Python $venv
    if ($LASTEXITCODE -ne 0) { throw "uv venv failed: $Repo" }
  }
  return Join-Path $venv 'Scripts\python.exe'
}

function Invoke-EnvironmentStep([string]$Name, [scriptblock]$Install) {
  try {
    $output = @(& $Install)
    foreach ($line in @($output | Where-Object { $_ -isnot [Collections.IDictionary] })) {
      Write-Host $line
    }
    $detail = @($output | Where-Object { $_ -is [Collections.IDictionary] } | Select-Object -Last 1)
    if ($detail.Count -ne 1) { throw "Environment step returned no status object: $Name" }
    return $detail[0]
  } catch {
    return [ordered]@{
      name = $Name
      ready = $false
      error = $_.Exception.Message
    }
  }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$script:Git = Resolve-RequiredCommand 'git'
$script:Uv = Resolve-RequiredCommand 'uv'

$repositories = @(
  (Sync-Repository 'ComfyUI' 'https://github.com/Comfy-Org/ComfyUI.git' 'a25c7bf2b8c7408d8724f4245dbe09d95992e3a1'),
  (Sync-Repository 'ACE-Step-1.5' 'https://github.com/ace-step/ACE-Step-1.5.git' '14c0211d5a0653b0f63e27686f4c3f151b4d8629'),
  (Sync-Repository 'Qwen3-TTS' 'https://github.com/QwenLM/Qwen3-TTS.git' '022e286b98fbec7e1e916cb940cdf532cd9f488e'),
  (Sync-Repository 'LTX-Video' 'https://github.com/Lightricks/LTX-Video.git' '4b2d053057623ddd4d0a1d3e9cd28890e9ef487f')
)

$environmentStatus = @()
if ($InstallEnvironments) {
  $environmentStatus += Invoke-EnvironmentStep 'ComfyUI' {
    $comfy = Join-Path $Root 'ComfyUI'
    $comfyPython = New-UvEnvironment $comfy
    & $script:Uv pip install --python $comfyPython torch torchvision torchaudio --index-url https://download.pytorch.org/whl/xpu
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI Intel XPU PyTorch install failed' }
    & $script:Uv pip install --python $comfyPython -r (Join-Path $comfy 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI requirements install failed' }
    Push-Location $comfy
    try {
      & $comfyPython -c "import torch; import folder_paths; assert hasattr(torch, 'xpu') and torch.xpu.is_available()"
      if ($LASTEXITCODE -ne 0) { throw 'ComfyUI import or Intel XPU proof failed' }
    } finally { Pop-Location }
    [ordered]@{ name = 'ComfyUI'; python = $comfyPython; backend = 'intel_xpu'; ready = $true }
  }

  $environmentStatus += Invoke-EnvironmentStep 'ACE-Step-1.5' {
    $ace = Join-Path $Root 'ACE-Step-1.5'
    $acePython = New-UvEnvironment $ace
    $dependencyJson = & $acePython -c "import json,tomllib,pathlib; p=tomllib.loads(pathlib.Path(r'$ace\pyproject.toml').read_text(encoding='utf-8')); blocked=('torch','torchvision','torchaudio','nano-vllm','flash-attn'); print(json.dumps([d for d in p['project']['dependencies'] if not d.lower().startswith(blocked)]))"
    if ($LASTEXITCODE -ne 0) { throw 'ACE-Step dependency manifest parse failed' }
    $aceDependencies = @($dependencyJson | ConvertFrom-Json)
    & $script:Uv pip install --python $acePython @aceDependencies
    if ($LASTEXITCODE -ne 0) { throw 'ACE-Step XPU-safe dependency install failed' }
    & $script:Uv pip install --python $acePython -e $ace --no-deps
    if ($LASTEXITCODE -ne 0) { throw 'ACE-Step local package install failed' }
    # Install XPU last: torchcodec and other transitive dependencies otherwise
    # replace the Intel build with a generic CPU wheel during resolution.
    & $script:Uv pip install --python $acePython --reinstall torch==2.13.0+xpu torchvision==0.28.0+xpu torchaudio==2.11.0+xpu --index-url https://download.pytorch.org/whl/xpu
    if ($LASTEXITCODE -ne 0) { throw 'ACE-Step Intel XPU PyTorch install failed' }
    & $acePython -c "import torch; import acestep; assert hasattr(torch, 'xpu') and torch.xpu.is_available()"
    if ($LASTEXITCODE -ne 0) { throw 'ACE-Step import or Intel XPU proof failed' }
    [ordered]@{ name = 'ACE-Step-1.5'; python = $acePython; backend = 'intel_xpu_pt'; ready = $true }
  }

  $environmentStatus += Invoke-EnvironmentStep 'Qwen3-TTS' {
    $tts = Join-Path $Root 'Qwen3-TTS'
    $ttsPython = New-UvEnvironment $tts
    & $script:Uv pip install --python $ttsPython torch torchaudio --index-url https://download.pytorch.org/whl/xpu
    if ($LASTEXITCODE -ne 0) { throw 'Qwen3-TTS Intel XPU PyTorch install failed' }
    & $script:Uv pip install --python $ttsPython -e $tts
    if ($LASTEXITCODE -ne 0) { throw 'Qwen3-TTS environment install failed' }
    & $ttsPython -c "import torch; import qwen_tts; assert hasattr(torch, 'xpu') and torch.xpu.is_available()"
    if ($LASTEXITCODE -ne 0) { throw 'Qwen3-TTS import or Intel XPU proof failed' }
    [ordered]@{ name = 'Qwen3-TTS'; python = $ttsPython; backend = 'intel_xpu'; ready = $true }
  }

  $environmentStatus += Invoke-EnvironmentStep 'LTX-Video' {
    $ltx = Join-Path $Root 'LTX-Video'
    $ltxPython = New-UvEnvironment $ltx '3.10'
    & $script:Uv pip install --python $ltxPython torch torchvision --index-url https://download.pytorch.org/whl/xpu
    if ($LASTEXITCODE -ne 0) { throw 'LTX-Video Intel XPU PyTorch install failed' }
    & $script:Uv pip install --python $ltxPython -e "$ltx[inference]"
    if ($LASTEXITCODE -ne 0) { throw 'LTX-Video environment install failed' }
    & $ltxPython -c "import torch; import ltx_video; assert hasattr(torch, 'xpu') and torch.xpu.is_available()"
    if ($LASTEXITCODE -ne 0) { throw 'LTX-Video import or Intel XPU proof failed' }
    [ordered]@{ name = 'LTX-Video'; python = $ltxPython; backend = 'intel_xpu'; ready = $true }
  }
}

$receiptRoot = 'C:\AtomEons\ai-box\receipts\captain-planet'
New-Item -ItemType Directory -Force -Path $receiptRoot | Out-Null
$environmentFailures = @($environmentStatus | Where-Object { -not $_.ready })
$receipt = [ordered]@{
  schema = 'orange.captain-planet.bootstrap.v1'
  status = if (-not $InstallEnvironments) {
    'SOURCE_SNAPSHOTS_VERIFIED'
  } elseif ($environmentFailures.Count -eq 0) {
    'ENVIRONMENTS_PREPARED_AWAITING_ARTIFACT_PROOF'
  } else {
    'ENVIRONMENT_PREP_NEEDS_WORK'
  }
  created_at = (Get-Date).ToUniversalTime().ToString('o')
  host = $env:COMPUTERNAME
  root = $Root
  repositories = $repositories
  environments = $environmentStatus
  artifact_proof_required = $true
}
$receiptJson = $receipt | ConvertTo-Json -Depth 8
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $receipt.sha256 = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($receiptJson))).Replace('-', '').ToLowerInvariant()
} finally {
  $sha.Dispose()
}
$receiptPath = Join-Path $receiptRoot 'bootstrap-latest.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -Encoding UTF8 $receiptPath
$receipt | ConvertTo-Json -Depth 8
