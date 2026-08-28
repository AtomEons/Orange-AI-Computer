$ErrorActionPreference = "Continue"

$Root = "C:\AtomEons\Orange5"
$ReceiptDir = Join-Path $Root "10-RECEIPTS\orange5-build"
$LogDir = Join-Path $ReceiptDir "logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$receiptPath = Join-Path $ReceiptDir "ae-eyes-services-$stamp.json"

function Test-Port {
  param([int]$Port)
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne(800, $false)
    if ($ok) { $client.EndConnect($async) }
    $client.Close()
    return [bool]$ok
  } catch {
    return $false
  }
}

function Start-Hidden {
  param(
    [string]$Name,
    [string]$Exe,
    [string[]]$Arguments,
    [string]$Cwd,
    [int]$Port
  )
  $before = Test-Port -Port $Port
  $started = $false
  $errorText = $null
  if (-not $before) {
    try {
      $out = Join-Path $LogDir "$Name.out.log"
      $err = Join-Path $LogDir "$Name.err.log"
      Start-Process -FilePath $Exe -ArgumentList $Arguments -WorkingDirectory $Cwd -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err | Out-Null
      $started = $true
      Start-Sleep -Seconds 2
    } catch {
      $errorText = $_.Exception.Message
    }
  }
  $after = Test-Port -Port $Port
  return [ordered]@{
    name = $Name
    exe = $Exe
    cwd = $Cwd
    port = $Port
    wasOpen = $before
    startAttempted = (-not $before)
    startIssued = $started
    isOpen = $after
    error = $errorText
  }
}

$services = @()

$services += Start-Hidden -Name "orange5-gateway" -Exe "bun.exe" -Arguments @("C:\AtomEons\Orange5\06-ORANGELLM\server\index.mjs") -Cwd "C:\AtomEons\Orange5\06-ORANGELLM\server" -Port 1337
$services += Start-Hidden -Name "orange5-hermes" -Exe "bun.exe" -Arguments @("C:\AtomEons\Orange5\08-HERMES\src\server.mjs") -Cwd "C:\AtomEons\Orange5\08-HERMES" -Port 7430
$services += Start-Hidden -Name "orange5-codexa-ollama-proxy" -Exe "node.exe" -Arguments @("C:\AtomEons\Orange5\docker\n150-runtime\codexa-ollama-host-proxy.mjs") -Cwd "C:\AtomEons\Orange5\docker\n150-runtime" -Port 11435

$env:COLPALI_PORT = "7440"
$services += Start-Hidden -Name "ae-eyes-colpali" -Exe "powershell.exe" -Arguments @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "C:\AtomEons\Orange5\07-VISUAL\colpali-service\start-codexa.ps1"
) -Cwd "C:\AtomEons\Orange5\07-VISUAL\colpali-service" -Port 7440

$cobraCandidates = @(
  "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flow-direct\server.mjs",
  "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\daemon.mjs",
  "C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\server.mjs",
  "C:\AtomEons\Orange5\07-VISUAL\ae-cobra\daemon.mjs",
  "C:\AtomEons\Orange5\07-VISUAL\ae-cobra\server.mjs"
)
$cobra = $cobraCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($cobra) {
  $services += Start-Hidden -Name "ae-cobra" -Exe "bun.exe" -Arguments @($cobra) -Cwd (Split-Path $cobra -Parent) -Port 7419
} else {
  $services += [ordered]@{
    name = "ae-cobra"
    port = 7419
    wasOpen = Test-Port -Port 7419
    startAttempted = $false
    startIssued = $false
    isOpen = Test-Port -Port 7419
    error = "No AE Cobra daemon entrypoint found in expected paths."
  }
}

$services += [ordered]@{
  name = "qdrant"
  port = 6333
  wasOpen = Test-Port -Port 6333
  startAttempted = $false
  startIssued = $false
  isOpen = Test-Port -Port 6333
  error = if (Test-Port -Port 6333) { $null } else { "Qdrant is not listening on 127.0.0.1:6333. Start existing Docker container or install qdrant service." }
}

$services += [ordered]@{
  name = "ollama-local"
  port = 11434
  wasOpen = Test-Port -Port 11434
  startAttempted = $false
  startIssued = $false
  isOpen = Test-Port -Port 11434
  error = if (Test-Port -Port 11434) { $null } else { "Local Ollama is not listening on 127.0.0.1:11434. Codexa proxy may be available on 11435." }
}

$serviceTaskName = "Orange5-AE-Eyes-Services"
try {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $serviceTaskName -Action $action -Trigger $trigger -Principal $principal -Description "Hidden Orange5 AE Eyes service bringup." -Force | Out-Null
  $taskStatus = "registered"
} catch {
  $taskStatus = "failed: $($_.Exception.Message)"
}

$tests = @()
foreach ($test in @(
  "C:\AtomEons\Orange5\07-VISUAL\tests\ae-eyes-backend.test.mjs",
  "C:\AtomEons\Orange5\07-VISUAL\tests\visual-facade.test.mjs"
)) {
  if (Test-Path $test) {
    $testOut = Join-Path $LogDir ("test-" + (Split-Path $test -Leaf) + "-$stamp.out.log")
    $testErr = Join-Path $LogDir ("test-" + (Split-Path $test -Leaf) + "-$stamp.err.log")
    $p = Start-Process -FilePath "bun.exe" -ArgumentList @($test) -WorkingDirectory "C:\AtomEons\Orange5\07-VISUAL" -NoNewWindow -Wait -PassThru -RedirectStandardOutput $testOut -RedirectStandardError $testErr
    $tests += [ordered]@{ file = $test; exitCode = $p.ExitCode; stdout = $testOut; stderr = $testErr }
  }
}

$receipt = [ordered]@{
  schema = "orange5.ae_eyes_services.v1"
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  root = $Root
  scheduledTask = [ordered]@{ name = $serviceTaskName; status = $taskStatus }
  services = $services
  tests = $tests
  verdict = if (($services | Where-Object { $_.name -in @("ae-eyes-colpali","ae-cobra","qdrant") -and -not $_.isOpen }).Count -eq 0 -and ($tests | Where-Object { $_.exitCode -ne 0 }).Count -eq 0) { "AE_EYES_SERVICE_CHAIN_GREEN" } else { "AE_EYES_SERVICE_CHAIN_NEEDS_WORK" }
}

($receipt | ConvertTo-Json -Depth 8) | Set-Content -Encoding UTF8 $receiptPath
Write-Output $receiptPath
