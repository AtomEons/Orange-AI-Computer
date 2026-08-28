$ErrorActionPreference = 'Stop'
$root = 'C:\AtomEons\Orange5'
& (Join-Path $root 'scripts\ensure-codexa-eyes-tunnel.ps1')
if ($LASTEXITCODE -ne 0) { throw 'AE Eyes tunnel setup failed' }
