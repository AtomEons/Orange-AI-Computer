param(
  [switch]$SkipUninstall,
  [switch]$NoStartAfterInstall
)

$ErrorActionPreference = "Continue"
$ts = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$root = "C:\AtomEons\Orange5"
$work = Join-Path $root "dist\docker-repair-$ts"
$receiptDir = Join-Path $root "10-RECEIPTS\orange5-build"
New-Item -ItemType Directory -Force -Path $work, $receiptDir | Out-Null
$log = Join-Path $work "docker-repair.log"

function Write-RepairLog {
  param([string]$Message)
  $line = "[$((Get-Date).ToUniversalTime().ToString("o"))] $Message"
  $line | Tee-Object -FilePath $log -Append
}

function Run-Capture {
  param(
    [string]$Label,
    [scriptblock]$Script
  )
  Write-RepairLog $Label
  try {
    & $Script 2>&1 | Tee-Object -FilePath $log -Append
  } catch {
    Write-RepairLog "ERROR: $($_.Exception.Message)"
  }
}

Write-RepairLog "Docker Desktop repair started."
Write-RepairLog "Preserve-data mode: no docker volume prune, no WSL unregister, no Docker data folder deletion."
Run-Capture "Current user" { whoami }
Run-Capture "Docker files before" {
  Get-Item "C:\Program Files\Docker\Docker\Docker Desktop.exe", "C:\Program Files\Docker\Docker\Docker Desktop Installer.exe" -ErrorAction SilentlyContinue |
    Select-Object FullName, @{ n = "Version"; e = { $_.VersionInfo.ProductVersion } }, LastWriteTime |
    Format-List
}
Run-Capture "Docker CLI before" { docker --version; docker compose version }
Run-Capture "WSL before" { wsl.exe -l -v }

Write-RepairLog "Stopping Docker Desktop processes."
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match "Docker|com\.docker|docker" } |
  ForEach-Object {
    Write-RepairLog "Stopping PID $($_.Id) $($_.ProcessName)"
    try { Stop-Process -Id $_.Id -Force -ErrorAction Stop } catch { Write-RepairLog "Stop failed: $($_.Exception.Message)" }
  }

Start-Sleep -Seconds 5
Run-Capture "WSL shutdown" { wsl.exe --shutdown }
Start-Sleep -Seconds 5

$installer = Join-Path $work "Docker Desktop Installer.exe"
$url = "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
Write-RepairLog "Downloading official Docker Desktop installer: $url"
curl.exe -L --fail --retry 3 --connect-timeout 20 --max-time 900 -o $installer $url 2>&1 |
  Tee-Object -FilePath $log -Append

if (!(Test-Path -LiteralPath $installer)) {
  throw "Installer download failed: $installer"
}

$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $installer
Write-RepairLog "Installer SHA256: $($hash.Hash)"

$existingInstaller = "C:\Program Files\Docker\Docker\Docker Desktop Installer.exe"
$uninstallExit = $null
if (!$SkipUninstall -and (Test-Path -LiteralPath $existingInstaller)) {
  Write-RepairLog "Running quiet uninstall via existing installer."
  $p = Start-Process -FilePath $existingInstaller -ArgumentList "uninstall --quiet" -Wait -PassThru -WindowStyle Hidden
  $uninstallExit = $p.ExitCode
  Write-RepairLog "Uninstall exit code: $uninstallExit"
} elseif ($SkipUninstall) {
  Write-RepairLog "SkipUninstall requested; running repair install only."
} else {
  Write-RepairLog "Existing installer not found; running repair install only."
}

Start-Sleep -Seconds 10
Write-RepairLog "Running quiet install with WSL2 backend."
$installProcess = Start-Process -FilePath $installer -ArgumentList "install --quiet --accept-license --backend=wsl-2" -Wait -PassThru -WindowStyle Hidden
$installExit = $installProcess.ExitCode
Write-RepairLog "Install exit code: $installExit"

Run-Capture "Docker files after" {
  Get-Item "C:\Program Files\Docker\Docker\Docker Desktop.exe", "C:\Program Files\Docker\Docker\Docker Desktop Installer.exe" -ErrorAction SilentlyContinue |
    Select-Object FullName, @{ n = "Version"; e = { $_.VersionInfo.ProductVersion } }, LastWriteTime |
    Format-List
}

if (!$NoStartAfterInstall) {
  $desktop = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  if (Test-Path -LiteralPath $desktop) {
    Write-RepairLog "Starting Docker Desktop."
    Start-Process -FilePath $desktop -WindowStyle Hidden
  } else {
    Write-RepairLog "Docker Desktop executable missing after install."
  }
} else {
  Write-RepairLog "NoStartAfterInstall requested; not starting Docker Desktop."
}

Write-RepairLog "Waiting for Docker engine for up to 6 minutes."
$dockerOk = $false
$dockerOut = ""
for ($i = 1; $i -le 72; $i++) {
  Start-Sleep -Seconds 5
  $dockerOut = (docker info 2>&1 | Out-String)
  if ($LASTEXITCODE -eq 0 -and $dockerOut -match "Server Version") {
    $dockerOk = $true
    Write-RepairLog "docker info OK at attempt $i"
    break
  }
  if ($i % 6 -eq 0) {
    $excerpt = $dockerOut.Substring(0, [Math]::Min(300, $dockerOut.Length))
    Write-RepairLog "docker info not ready attempt ${i}: $excerpt"
  }
}

Run-Capture "Docker CLI after" { docker --version; docker compose version }
Run-Capture "WSL after" { wsl.exe -l -v }

$dockerInfoExcerpt = ""
if ($dockerOut) {
  $dockerInfoExcerpt = $dockerOut.Substring(0, [Math]::Min(4000, $dockerOut.Length))
}

$receipt = [ordered]@{
  schema = "orange.receipt.docker_repair.v1"
  status = if ($dockerOk) { "DOCKER_REINSTALL_GREEN" } else { "DOCKER_REINSTALL_NEEDS_ATTENTION" }
  timestamp_utc = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  work_dir = $work
  log = $log
  installer = $installer
  installer_sha256 = $hash.Hash
  data_preservation = "No docker volume prune; no WSL unregister; no Docker data folder deletion."
  uninstall_exit_code = $uninstallExit
  install_exit_code = $installExit
  docker_info_ok = $dockerOk
  docker_info_excerpt = $dockerInfoExcerpt
}

$receiptPath = Join-Path $receiptDir "docker-repair-$ts.json"
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
Write-RepairLog "Receipt written: $receiptPath"
Write-Output $receiptPath
