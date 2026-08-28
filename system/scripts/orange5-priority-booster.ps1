param(
  [string]$CodexaOllamaUrl = $(if ($env:ORANGE5_CODEXA_OLLAMA_URL) { $env:ORANGE5_CODEXA_OLLAMA_URL } else { 'http://10.0.0.4:11434' }),
  [string]$LogPath = 'C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\runtime-logs\orange5-priority-booster.jsonl',
  [switch]$SkipPriority
)
$ErrorActionPreference = 'SilentlyContinue'
$targets = @(
  @{Name='Codex'; Priority='High'; Match=$null},
  @{Name='claude'; Priority='High'; Match=$null},
  @{Name='obs64'; Priority='High'; Match=$null},
  @{Name='obs32'; Priority='High'; Match=$null},
  @{Name='ollama'; Priority='AboveNormal'; Match='\bserve\b'},
  @{Name='node'; Priority='AboveNormal'; Match='C:\\AtomEons\\Orange5'},
  @{Name='bun'; Priority='AboveNormal'; Match='C:\\AtomEons\\Orange5|OrangeBox-Data\\atomsmasher2-final-local|03-BACKEND|06-ORANGELLM|07-VISUAL|08-HERMES|12-ATOMSMASHER'}
)
$events = @()
if (-not $SkipPriority) {
  foreach ($t in $targets) {
    Get-Process -Name $t.Name -ErrorAction SilentlyContinue | ForEach-Object {
      $cmd = $null
      try { $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine } catch {}
      if (-not $t.Match -or ($cmd -match $t.Match)) {
        try { $_.PriorityClass = $t.Priority; $events += [pscustomobject]@{process=$_.ProcessName; id=$_.Id; priority=$t.Priority; ok=$true} }
        catch { $events += [pscustomobject]@{process=$_.ProcessName; id=$_.Id; priority=$t.Priority; ok=$false; error=$_.Exception.Message} }
      }
    }
  }
}

# Observe Navigator residency without pinning model weights forever. The
# OrangeLLM specialist lease loads the selected model on demand and unloads
# competing generative weights under the 50 GiB governor.
$navigatorModel = 'orange-navigator:ornith-1.5-9b-q4km'
$codexaOllama = $CodexaOllamaUrl.TrimEnd('/')
$navigator = [ordered]@{model=$navigatorModel; endpoint=$codexaOllama; reachable=$false; warm=$false; residency_policy='lease_on_demand'; error=$null}
try {
  $ps = Invoke-RestMethod -Uri "$codexaOllama/api/ps" -Method Get -TimeoutSec 4
  $navigator.reachable = $true
  $navigator.warm = @($ps.models | ForEach-Object { $_.name }) -contains $navigatorModel
} catch {
  $navigator.error = $_.Exception.Message
}

$logDir = Split-Path -Parent $LogPath
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
[ordered]@{schema='orange.receipt.priority_booster.v2'; timestamp_utc=(Get-Date).ToUniversalTime().ToString('o'); events=$events; navigator=$navigator} | ConvertTo-Json -Depth 6 -Compress | Add-Content -Path $LogPath -Encoding UTF8
if ((Get-Item -LiteralPath $LogPath).Length -gt 5MB) {
  $tail = Get-Content -LiteralPath $LogPath -Tail 1000
  Set-Content -LiteralPath $LogPath -Value $tail -Encoding UTF8
}
