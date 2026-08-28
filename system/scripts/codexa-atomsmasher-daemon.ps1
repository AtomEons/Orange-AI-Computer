$ErrorActionPreference = 'Stop'
$root = 'C:\AtomEons\ai-box\atomsmasher2'
$bun = Join-Path $env:USERPROFILE '.bun\bin\bun.exe'
$entry = Join-Path $root 'start-daemon.mjs'
$logDir = Join-Path $root 'logs'

if (Get-NetTCPConnection -State Listen -LocalPort 8901 -ErrorAction SilentlyContinue) { exit 0 }
if (-not (Test-Path -LiteralPath $bun)) { throw "Bun not found: $bun" }
if (-not (Test-Path -LiteralPath $entry)) { throw "AtomSmasher entry not found: $entry" }

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:PORT = '8901'
$env:ATOMSMASHER_DB = Join-Path $root 'atomsmasher2.db'
Start-Process -FilePath $bun -ArgumentList @($entry) -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'daemon.stdout.log') `
  -RedirectStandardError (Join-Path $logDir 'daemon.stderr.log')
