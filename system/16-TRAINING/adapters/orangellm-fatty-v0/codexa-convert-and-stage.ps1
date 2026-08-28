param(
  [string]$WorkRoot = "C:\AtomEons\models\orangellm-fatty-v0",
  [string]$LlamaCppRoot = "C:\AtomEons\tools\llama.cpp-src",
  [string]$BaseConfigRoot = "C:\AtomEons\tools\qwen2.5-32b-instruct-config",
  [string]$CandidateModel = "orangebrain-trained:v0"
)

$ErrorActionPreference = "Stop"
$adapterDir = Join-Path $WorkRoot "adapter"
$adapterFile = Join-Path $adapterDir "adapter_model.safetensors"
$adapterGguf = Join-Path $WorkRoot "orangellm-fatty-v0-f16.gguf"
$venv = Join-Path $WorkRoot ".convert-venv"
$modelfile = Join-Path $WorkRoot "Modelfile.candidate"
$receipt = Join-Path $WorkRoot "conversion-receipt.json"
$ollama = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"

foreach ($required in @($adapterFile, (Join-Path $adapterDir "adapter_config.json"))) {
  if (-not (Test-Path $required)) { throw "Required adapter artifact missing: $required" }
}
$baseConfig = Join-Path $BaseConfigRoot "config.json"
if (-not (Test-Path $baseConfig)) { throw "Exact Qwen2.5 base config missing: $baseConfig" }
$expectedConfigHash = "9c6772f138ef9e5b3d1c18f2c87e451bbc01f5f1a4eabb36f9bf4f53829b903e"
$actualConfigHash = (Get-FileHash -Algorithm SHA256 $baseConfig).Hash.ToLowerInvariant()
if ($actualConfigHash -ne $expectedConfigHash) { throw "Qwen2.5 base config hash mismatch: $actualConfigHash" }
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw "uv is required on Codexa" }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw "git is required on Codexa" }
if (-not (Test-Path $ollama)) { throw "Ollama executable missing: $ollama" }

New-Item -ItemType Directory -Force (Split-Path $LlamaCppRoot) | Out-Null
$converter = Join-Path $LlamaCppRoot "convert_lora_to_gguf.py"
if (-not (Test-Path $converter)) {
  git clone --depth 1 https://github.com/ggml-org/llama.cpp.git $LlamaCppRoot
  if ($LASTEXITCODE -ne 0) { throw "Unable to acquire llama.cpp source" }
} elseif (Test-Path (Join-Path $LlamaCppRoot ".git")) {
  git -C $LlamaCppRoot pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Warning "llama.cpp update unavailable; using installed source" }
}
$llamaRevision = if (Test-Path (Join-Path $LlamaCppRoot ".git")) {
  (git -C $LlamaCppRoot rev-parse HEAD).Trim()
} elseif (Test-Path (Join-Path $LlamaCppRoot "ORANGE_SOURCE_REVISION")) {
  (Get-Content (Join-Path $LlamaCppRoot "ORANGE_SOURCE_REVISION") -Raw).Trim()
} else { "source-snapshot-unversioned" }

if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
  uv venv --python 3.12 $venv
  if ($LASTEXITCODE -ne 0) { throw "Unable to create conversion virtual environment" }
}
$python = Join-Path $venv "Scripts\python.exe"
$requirements = Join-Path $LlamaCppRoot "requirements\requirements-convert_lora_to_gguf.txt"
uv pip install --python $python --index-strategy unsafe-best-match -r $requirements
if ($LASTEXITCODE -ne 0) { throw "Conversion dependency installation failed" }

& $python $converter `
  --base $BaseConfigRoot `
  --outfile $adapterGguf `
  --outtype f16 `
  $adapterDir
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $adapterGguf)) { throw "LoRA GGUF conversion failed" }

$system = "You are OrangeBrain, the governed PM brain of OrangeFive. Follow orange.order.v1. Return orange.report.v1 for operational work. No fake green. No theater. Cite evidence and receipts. Reality overrides recollection."
@"
FROM qwen2.5:32b-instruct-q4_K_M
ADAPTER $adapterGguf
SYSTEM """$system"""
PARAMETER temperature 0.2
PARAMETER top_p 0.9
PARAMETER repeat_penalty 1.05
PARAMETER num_ctx 8192
"@ | Set-Content -LiteralPath $modelfile -Encoding utf8

& $ollama create $CandidateModel -f $modelfile
if ($LASTEXITCODE -ne 0) { throw "Ollama rejected the converted adapter; do not promote it" }

$adapterSourceHash = (Get-FileHash -Algorithm SHA256 $adapterFile).Hash.ToLowerInvariant()
$adapterGgufHash = (Get-FileHash -Algorithm SHA256 $adapterGguf).Hash.ToLowerInvariant()
$models = (& $ollama list | Out-String)
$candidatePresent = $models -match [regex]::Escape($CandidateModel)
$result = [ordered]@{
  schema = "orange5.orangebrain.codexa-conversion.v1"
  generated_at = (Get-Date).ToUniversalTime().ToString("o")
  status = if ($candidatePresent) { "CANDIDATE_STAGED_NOT_PROMOTED" } else { "CONVERSION_FAILED" }
  source_adapter = $adapterFile
  source_adapter_sha256 = $adapterSourceHash
  gguf_adapter = $adapterGguf
  gguf_adapter_sha256 = $adapterGgufHash
  gguf_adapter_bytes = (Get-Item $adapterGguf).Length
  exact_base = "Qwen/Qwen2.5-32B-Instruct"
  exact_base_config_sha256 = $actualConfigHash
  ollama_base = "qwen2.5:32b-instruct-q4_K_M"
  candidate_model = $CandidateModel
  candidate_present = $candidatePresent
  llama_cpp_revision = $llamaRevision
  promoted = $false
}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receipt -Encoding utf8
$result | ConvertTo-Json -Depth 6
if (-not $candidatePresent) { exit 1 }
