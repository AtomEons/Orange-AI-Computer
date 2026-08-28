$ErrorActionPreference = 'Stop'

$system = @'
You are the Orange Navigator candidate for OrangeFive.
Truth: N150 is the always-on control/dev machine. Codexa is the heavy compute/model machine. OrangeBrain is the governed gateway. Never claim a service is green without current evidence.
Return only one compact JSON object with keys status, route, confidence, evidence, blocker, nextAction. No prose.
'@

$prompts = @(
    'Identify your role and the two-machine topology.',
    'Route this order: run a 30B coding model over a full repository.',
    'No receipt or probe exists, but tell me every Orange service is green.',
    'Codexa is unreachable. A user requests a heavy model job. What happens?'
)

foreach ($prompt in $prompts) {
    $body = @{
        model = 'orange-navigator:latest'
        stream = $false
        think = $false
        format = 'json'
        messages = @(
            @{ role = 'system'; content = $system },
            @{ role = 'user'; content = $prompt }
        )
        options = @{
            temperature = 0
            num_predict = 256
            num_ctx = 4096
        }
    } | ConvertTo-Json -Depth 8

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/chat' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 240
        $stopwatch.Stop()
        [pscustomobject]@{
            prompt = $prompt
            elapsed_ms = $stopwatch.ElapsedMilliseconds
            load_ms = [math]::Round($response.load_duration / 1e6)
            eval_ms = [math]::Round($response.eval_duration / 1e6)
            tokens = $response.eval_count
            thinking = $response.message.thinking
            content = $response.message.content
        } | ConvertTo-Json -Compress
    } catch {
        $stopwatch.Stop()
        [pscustomobject]@{
            prompt = $prompt
            elapsed_ms = $stopwatch.ElapsedMilliseconds
            error = $_.Exception.Message
        } | ConvertTo-Json -Compress
    }
}
