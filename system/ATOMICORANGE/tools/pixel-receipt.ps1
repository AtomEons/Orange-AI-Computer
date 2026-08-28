# pixel-receipt.ps1 - N3 harness v2: capture the LIVE native organism (window +
# HUD) to a timestamped PNG receipt via PrintWindow - works even when the window
# is OCCLUDED or unfocused (no more foreground fights). Free, no deps.
#   powershell -ExecutionPolicy Bypass -File tools\pixel-receipt.ps1 [-Label calm]
# Receipts land in C:\AtomEons\Orange5\10-RECEIPTS\atomic-orange\pixel\
# Law: no visual green without a pixel receipt (AOMBP N3).
param([string]$Label = "state")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$proc = Get-Process atomic-orange -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq 0) { Write-Output "FAIL: atomic-orange.exe not running (or no window)"; exit 1 }

$sig = '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);' + "`n" +
       '[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);' + "`n" +
       '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' + "`n" +
       '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);' + "`n" +
       '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);' + "`n" +
       'public struct RECT { public int Left, Top, Right, Bottom; }'
try { Add-Type -MemberDefinition $sig -Name Win -Namespace Cap -ErrorAction Stop } catch {}
# DPI-aware: GetWindowRect must return PHYSICAL pixels or the capture crops
[void][Cap.Win]::SetProcessDPIAware()

# minimized windows report a tiny iconic rect - restore before shooting
if ([Cap.Win]::IsIconic($proc.MainWindowHandle)) {
    [void][Cap.Win]::ShowWindow($proc.MainWindowHandle, 9)
    Start-Sleep -Milliseconds 450
}
# DETERMINISTIC FRAME: park the window at a known origin and size so every
# receipt is the same geometry - kills the cropped/white-band artifact that
# made frames disagree with what the app actually drew.
$sig2 = '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'
try { Add-Type -MemberDefinition $sig2 -Name Win2 -Namespace Cap -ErrorAction Stop } catch {}
[void][Cap.Win2]::SetWindowPos($proc.MainWindowHandle, [IntPtr]::Zero, 0, 0, 1728, 972, 0x0040)
Start-Sleep -Milliseconds 600
$r = New-Object 'Cap.Win+RECT'
[void][Cap.Win]::GetWindowRect($proc.MainWindowHandle, [ref]$r)
$w = [Math]::Max(2, $r.Right - $r.Left)
$h = [Math]::Max(2, $r.Bottom - $r.Top)

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT (2): captures GPU-composited content (wgpu swapchain)
$ok = [Cap.Win]::PrintWindow($proc.MainWindowHandle, $hdc, 2)
$g.ReleaseHdc($hdc)

if (-not $ok) { Write-Output "WARN: PrintWindow returned false - receipt may be black" }

$dir = "C:\AtomEons\Orange5\10-RECEIPTS\atomic-orange\pixel"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$path = Join-Path $dir "$stamp-$Label.png"
$bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "PIXEL_RECEIPT: $path"
