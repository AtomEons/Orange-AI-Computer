$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bun = (Get-Command bun.exe -ErrorAction Stop).Source
$entry = Join-Path $root 'mirror-daemon.mjs'
$status = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\ae-cobra-mirror-daemon-status.json'

$existing = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'bun.exe' -and $_.CommandLine -like '*ae-cobra*mirror-daemon.mjs*' }
if ($existing) { exit 0 }

$env:ORANGEBOX_RAIL_TOKEN = [Environment]::GetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN', 'User')
if (-not $env:ORANGEBOX_RAIL_TOKEN) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $status) | Out-Null
  @{ schema='orange5.ae_cobra.mirror_daemon_status.v1'; state='blocked'; reason='missing_user_rail_token'; updatedAt=(Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $status -Encoding utf8
  exit 2
}

Start-Process -FilePath $bun -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden
