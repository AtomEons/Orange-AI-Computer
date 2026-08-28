param(
  [string]$Archive = "C:\AtomEons\tools\llama.cpp-src-orange-snapshot.tar.gz",
  [string]$Destination = "C:\AtomEons\tools\llama.cpp-src"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Archive)) { throw "llama.cpp source snapshot missing: $Archive" }
New-Item -ItemType Directory -Force $Destination | Out-Null
tar -xzf $Archive -C $Destination
if ($LASTEXITCODE -ne 0) { throw "llama.cpp source extraction failed" }
$converter = Join-Path $Destination "convert_lora_to_gguf.py"
if (-not (Test-Path $converter)) { throw "Converter missing after extraction: $converter" }
$revision = (Get-Content (Join-Path $Destination "ORANGE_SOURCE_REVISION") -Raw).Trim()
[ordered]@{
  status = "LLAMA_CPP_SOURCE_READY"
  destination = $Destination
  revision = $revision
  converter = $converter
} | ConvertTo-Json

