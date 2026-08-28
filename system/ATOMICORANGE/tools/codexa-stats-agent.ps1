# codexa-stats-agent.ps1 - runs ON the CODEXA AI box (the 98GB Beelink).
# Serves machine truth as JSON on http://0.0.0.0:8799/stats for Atomic Orange's
# AI ESTATE panel: CPU, memory, per-disk free space (boot-overload armor),
# network counters, and nvidia-smi GPU stats when an NVIDIA GPU is present.
# ASCII only, PowerShell 5.1 compatible, zero dependencies.
#
# Install on CODEXA (one time, admin PowerShell):
#   1. Copy this file to C:\AtomEons\codexa-stats-agent.ps1
#   2. netsh advfirewall firewall add rule name="codexa-stats-8799" dir=in action=allow protocol=TCP localport=8799
#   3. powershell -ExecutionPolicy Bypass -File C:\AtomEons\codexa-stats-agent.ps1
#   (optional: register as a scheduled task at logon so it survives reboots)
#
# Verify from the N150:  curl http://CODEXA.local:8799/stats

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://+:8799/")
try {
    $listener.Start()
} catch {
    Write-Output "FAIL: cannot bind :8799 (run as admin once, or: netsh http add urlacl url=http://+:8799/ user=Everyone)"
    exit 1
}
Write-Output "codexa-stats-agent: serving http://0.0.0.0:8799/stats"

$cpuCounter = $null
try { $cpuCounter = New-Object System.Diagnostics.PerformanceCounter("Processor", "% Processor Time", "_Total"); [void]$cpuCounter.NextValue() } catch {}

while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
        if ($ctx.Request.Url.AbsolutePath -ne "/stats") {
            $res.StatusCode = 404
            $body = [System.Text.Encoding]::UTF8.GetBytes('{"error":"use /stats"}')
        } else {
            # CPU
            $cpu = -1.0
            if ($cpuCounter) { try { $cpu = [math]::Round($cpuCounter.NextValue(), 1) } catch {} }
            # memory
            $os = Get-CimInstance Win32_OperatingSystem
            $memTotal = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
            $memFree = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
            # disks (fixed drives only) - the boot-overload armor reads these
            $disks = @()
            foreach ($d in (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")) {
                $disks += @{
                    mount = $d.DeviceID
                    total_gb = [math]::Round($d.Size / 1GB, 1)
                    free_gb = [math]::Round($d.FreeSpace / 1GB, 1)
                }
            }
            # network cumulative counters (all up adapters)
            $rx = 0; $tx = 0
            foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
                if ($n.OperationalStatus -eq "Up" -and $n.NetworkInterfaceType -ne "Loopback") {
                    $s = $n.GetIPv4Statistics()
                    $rx += $s.BytesReceived; $tx += $s.BytesSent
                }
            }
            # nvidia truth when present (the "cool stat tool", mirrored)
            $gpu = $null
            $smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
            if ($smi) {
                try {
                    $line = (& nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits 2>$null | Select-Object -First 1)
                    if ($line) {
                        $p = $line -split ",\s*"
                        $gpu = @{ util_pct = [double]$p[0]; vram_used_mb = [double]$p[1]; vram_total_mb = [double]$p[2]; temp_c = [double]$p[3] }
                    }
                } catch {}
            }
            $payload = @{
                host = $env:COMPUTERNAME
                ts = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
                cpu_pct = $cpu
                mem_total_gb = $memTotal
                mem_free_gb = $memFree
                disks = $disks
                net_rx_bytes = $rx
                net_tx_bytes = $tx
                gpu = $gpu
            }
            $json = $payload | ConvertTo-Json -Depth 4 -Compress
            $body = [System.Text.Encoding]::UTF8.GetBytes($json)
            $res.ContentType = "application/json"
        }
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
    } catch {
        # one bad request must never kill the agent
    } finally {
        try { $res.Close() } catch {}
    }
}
