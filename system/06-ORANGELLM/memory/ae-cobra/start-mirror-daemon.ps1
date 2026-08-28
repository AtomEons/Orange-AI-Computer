$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = (Get-Command bun.exe -ErrorAction Stop).Source
$entry = Join-Path $root 'mirror-daemon.mjs'
$status = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-mirror-daemon-status.json'

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*ae-cobra*mirror-daemon.mjs*' }
if ($existing) { exit 0 }

Start-Process -FilePath $bun -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden
