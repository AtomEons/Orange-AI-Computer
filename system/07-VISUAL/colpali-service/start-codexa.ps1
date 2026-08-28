$ErrorActionPreference = "Stop"

$root = "C:\AtomEons\Orange5\07-VISUAL\colpali-service"
$env:COLPALI_PYTHON = "$root\.venv\Scripts\python.exe"
$env:COLPALI_MODEL_ID = "C:\Users\Atom\OrangeBox-Data\models\colqwen2-v1.0-hf"
$env:COLPALI_TORCH_DEVICE = "xpu"
$env:COLPALI_PORT = "7440"
$env:COLPALI_TIMEOUT_MS = "600000"
$env:COLPALI_RESIDENT_WORKER = "1"
$env:COLPALI_QUEUE_DB = "C:\Users\Atom\OrangeBox-Data\orange5\ae-eyes-queue.db"
$env:TRANSFORMERS_OFFLINE = "1"
$env:HF_HOME = "C:\Users\Atom\OrangeBox-Data\models\huggingface"

Set-Location $root
& "C:\Users\Atom\.bun\bin\bun.exe" "$root\server.mjs"
