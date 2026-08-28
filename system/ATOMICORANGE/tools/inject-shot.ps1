# inject-shot.ps1 — focus the organism and fire self-photograph keys.
# Usage: powershell -File tools\inject-shot.ps1 [-Keys "s"]  (default: calm+alert pair)
param([string]$Keys = "pair")
$s = New-Object -ComObject WScript.Shell
$p = Get-Process atomic-orange -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "NO_PROC"; exit 1 }
[void]$s.AppActivate($p.Id)
Start-Sleep -Milliseconds 700
if ($Keys -eq "pair") {
    $s.SendKeys("s"); Start-Sleep -Milliseconds 1500
    $s.SendKeys("2"); Start-Sleep -Milliseconds 900
    $s.SendKeys("s"); Start-Sleep -Milliseconds 1200
    $s.SendKeys("1")
} else {
    $s.SendKeys($Keys)
}
Write-Output "SENT"
