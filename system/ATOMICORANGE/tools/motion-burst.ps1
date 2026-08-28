# motion-burst.ps1 - MOTION receipts: N PrintWindow frames at a fixed cadence,
# one warm process (no cold-start gaps). The single-still lie ends here: motion
# is judged from sequences. ASCII only (PS 5.1 law).
#   powershell -ExecutionPolicy Bypass -File tools\motion-burst.ps1 [-Frames 12] [-GapMs 500] [-Label motion]
# Frames land in C:\AtomEons\Orange5\10-RECEIPTS\atomic-orange\pixel\burst\
param([int]$Frames = 12, [int]$GapMs = 500, [string]$Label = "motion")

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$proc = Get-Process atomic-orange -ErrorAction SilentlyContinue
if (-not $proc -or $proc.MainWindowHandle -eq 0) { Write-Output "FAIL: atomic-orange.exe not running (or no window)"; exit 1 }

$sig = '[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);' + "`n" +
       '[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);' + "`n" +
       '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();' + "`n" +
       'public struct RECT { public int Left, Top, Right, Bottom; }'
try { Add-Type -MemberDefinition $sig -Name Win -Namespace Cap -ErrorAction Stop } catch {}
[void][Cap.Win]::SetProcessDPIAware()

$hwnd = $proc.MainWindowHandle
$r = New-Object Cap.Win+RECT
[void][Cap.Win]::GetWindowRect($hwnd, [ref]$r)
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { Write-Output "FAIL: bad window rect"; exit 1 }

$dir = "C:\AtomEons\Orange5\10-RECEIPTS\atomic-orange\pixel\burst"
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
$ts = Get-Date -Format "yyyy-MM-dd_HHmmss"

for ($i = 1; $i -le $Frames; $i++) {
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $ok = [Cap.Win]::PrintWindow($hwnd, $hdc, 2)
    $g.ReleaseHdc($hdc); $g.Dispose()
    $n = "{0:d2}" -f $i
    $path = Join-Path $dir "$ts-$Label-f$n.png"
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    if (-not $ok) { Write-Output "WARN: frame $n PrintWindow false" }
    if ($i -lt $Frames) { Start-Sleep -Milliseconds $GapMs }
}
Write-Output "MOTION_BURST: $dir\$ts-$Label-f01..f$("{0:d2}" -f $Frames).png"
