#requires -Version 5.1
<#
===========================================================================
AE Misfit v0 — Codexa deploy ceremony
---------------------------------------------------------------------------
Disclosure   : ATOM-AEMISFIT-V0-DEPLOY-2026-0624
Role         : Operator-fired one-shot deploy of the trained LoRA adapter
               from the N150 workstation to the Codexa server, then
               registration of the merged model in Ollama on Codexa.
Pipeline ref : Wave 2 #027 — ae-misfit-v0.yaml / ae-misfit-v0.ipynb
Source       : C:\AtomEons\Orange5\16-TRAINING\adapters\ae-misfit-v0\
Target       : codexa:/opt/atomeons/adapters/ae-misfit-v0/
Operator     : Atom McCree (AtomEons)
---------------------------------------------------------------------------
Mom's Law: this script is operator-fired ONLY, after the operator has
trained the adapter in the ae-misfit-v0.ipynb notebook and verified that
adapter_config.json + adapter_model.safetensors exist locally. We do NOT
silently fetch from Colab, we do NOT auto-promote, and we do NOT skip the
sha256 verification step. If the local adapter is missing or unverified,
we exit non-zero with a stated blocker — no theater.

Honesty boundary:
  - The TRAINING happens in Colab (free T4, unsloth/Qwen2.5-7B-Instruct-bnb-4bit).
  - The operator manually downloads the adapter into the local adapter dir
    before invoking this script.
  - This script does NOT train, does NOT validate refusal-corpus accuracy
    (that is bakeoff-second-opinion.mjs's job), and does NOT wire Hermes
    middleware (that is the Hermes pre-action gate's deploy step).
  - Risk level: HIGH. This places a new model on the production refusal
    gate path. Operator must confirm with --Confirm before the rsync.

Requires on Codexa:
  - ollama (>= 0.1.40, ADAPTER directive support)
  - rsync, ssh, sha256sum, install
  - /opt/atomeons/adapters/ writable by $env:ATOM_CODEXA_USER

Requires on N150 (local Windows):
  - OpenSSH client (built into Windows 10/11)
  - rsync via WSL OR rsync.exe on PATH (cwRsync / MSYS2). We auto-detect.
  - Get-FileHash (built-in)

Env vars:
  ATOM_CODEXA_SSH_KEY   absolute path to the private key (mandatory)
  ATOM_CODEXA_HOST      hostname or IP of Codexa     (default: codexa.atomeons.local)
  ATOM_CODEXA_USER      ssh user on Codexa           (default: atomeons)
  ATOM_CODEXA_PORT      ssh port                     (default: 22)

Exit codes:
  0  success — adapter rsynced, sha256 matches, ollama create succeeded
  2  missing local artifact (adapter_config.json or safetensors)
  3  missing required env (ATOM_CODEXA_SSH_KEY)
  4  ssh / rsync transport failure
  5  remote sha256 mismatch
  6  ollama create failure on Codexa
  7  --Confirm not supplied (dry-run safety stop)
===========================================================================
#>

[CmdletBinding()]
param(
    # Operator must pass -Confirm to actually transmit. Without it we do a
    # dry-run plan-and-quit so the operator can read what would happen.
    [switch]$Confirm,

    # Skip the ollama create step on Codexa (e.g. when the operator only
    # wants to stage the bytes for a manual review pass).
    [switch]$SkipOllamaCreate,

    # Override the adapter dir if running from a different working tree.
    [string]$AdapterDir = (Join-Path $PSScriptRoot '.'),

    # Ollama model tag on Codexa. Bakeoff harness reads this.
    [string]$OllamaTag = 'ae-misfit:v0'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($msg)  { Write-Host "[deploy] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)    { Write-Host "[ ok  ] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[warn ] $msg" -ForegroundColor Yellow }
function Write-Err2($msg)  { Write-Host "[ err ] $msg" -ForegroundColor Red }

# ---------------------------------------------------------------------------
# 1. Validate environment
# ---------------------------------------------------------------------------
Write-Step 'Validating environment'

$sshKey = $env:ATOM_CODEXA_SSH_KEY
if (-not $sshKey -or -not (Test-Path -LiteralPath $sshKey)) {
    Write-Err2 'ATOM_CODEXA_SSH_KEY env var is unset or points to a missing file.'
    Write-Err2 'Set it to the absolute path of your Codexa private key, e.g.:'
    Write-Err2 '    $env:ATOM_CODEXA_SSH_KEY = "C:\Users\a\.ssh\codexa_ed25519"'
    exit 3
}

$codexaHost = if ($env:ATOM_CODEXA_HOST) { $env:ATOM_CODEXA_HOST } else { 'codexa.atomeons.local' }
$codexaUser = if ($env:ATOM_CODEXA_USER) { $env:ATOM_CODEXA_USER } else { 'atomeons' }
$codexaPort = if ($env:ATOM_CODEXA_PORT) { $env:ATOM_CODEXA_PORT } else { '22' }
$codexaTarget = '/opt/atomeons/adapters/ae-misfit-v0/'

Write-Ok ("host = {0}@{1}:{2}" -f $codexaUser, $codexaHost, $codexaPort)
Write-Ok ("key  = {0}" -f $sshKey)
Write-Ok ("dst  = {0}" -f $codexaTarget)

# Resolve adapter dir absolutely
$AdapterDir = (Resolve-Path -LiteralPath $AdapterDir).Path
Write-Ok ("src  = {0}" -f $AdapterDir)

# ---------------------------------------------------------------------------
# 2. Validate local artifacts
# ---------------------------------------------------------------------------
# The notebook drops a HuggingFace-style PEFT/LoRA dir. We canonicalize the
# safetensors name to adapter.safetensors so the Modelfile's `ADAPTER
# ./adapter.safetensors` line resolves on Codexa without further edits.
Write-Step 'Validating local artifacts'

$modelfile = Join-Path $AdapterDir 'Modelfile.ae-misfit-v0'
$adapterCfg = Join-Path $AdapterDir 'adapter_config.json'
$adapterStHF = Join-Path $AdapterDir 'adapter_model.safetensors'   # HF default name
$adapterStOL = Join-Path $AdapterDir 'adapter.safetensors'         # Modelfile expects this

$missing = @()
if (-not (Test-Path -LiteralPath $modelfile))  { $missing += 'Modelfile.ae-misfit-v0' }
if (-not (Test-Path -LiteralPath $adapterCfg)) { $missing += 'adapter_config.json' }
if (-not (Test-Path -LiteralPath $adapterStHF) -and -not (Test-Path -LiteralPath $adapterStOL)) {
    $missing += 'adapter_model.safetensors OR adapter.safetensors'
}

if ($missing.Count -gt 0) {
    Write-Err2 'Local adapter dir is incomplete. Missing:'
    foreach ($m in $missing) { Write-Err2 "  - $m" }
    Write-Err2 ''
    Write-Err2 'Train the adapter first by firing ae-misfit-v0.ipynb in Colab,'
    Write-Err2 'then download the result into:'
    Write-Err2 "  $AdapterDir"
    exit 2
}

# Canonicalize: if only the HF name exists, copy it to the Ollama-expected name.
if ((Test-Path -LiteralPath $adapterStHF) -and -not (Test-Path -LiteralPath $adapterStOL)) {
    Write-Step 'Canonicalizing adapter_model.safetensors -> adapter.safetensors'
    Copy-Item -LiteralPath $adapterStHF -Destination $adapterStOL -Force
}

# Verify adapter_config.json claims the expected base model. This is the
# single best cheap guard against deploying a mis-trained adapter (e.g. one
# trained on a different Qwen variant that would silently degrade at runtime).
$cfgJson = Get-Content -LiteralPath $adapterCfg -Raw | ConvertFrom-Json
$claimedBase = $cfgJson.base_model_name_or_path
$expectedBaseFragment = 'Qwen2.5-7B-Instruct'
if (-not $claimedBase) {
    Write-Err2 'adapter_config.json has no base_model_name_or_path field.'
    exit 2
}
if ($claimedBase -notmatch [regex]::Escape($expectedBaseFragment)) {
    Write-Err2 ("adapter_config.json base_model = '{0}'" -f $claimedBase)
    Write-Err2 ("expected fragment              = '{0}'" -f $expectedBaseFragment)
    Write-Err2 'Refusing to deploy a LoRA trained on a different base. This is a Mom-grade guard.'
    exit 2
}
Write-Ok ("adapter_config base_model = {0}" -f $claimedBase)

# ---------------------------------------------------------------------------
# 3. Compute local sha256 manifest
# ---------------------------------------------------------------------------
Write-Step 'Computing local sha256 manifest'

# Only the files we will rsync. Anything else in the dir (notebooks,
# checkpoints/, README) is intentionally excluded from the transfer below.
$payloadFiles = @(
    'Modelfile.ae-misfit-v0',
    'adapter_config.json',
    'adapter.safetensors'
)
# Include tokenizer files if present (HF PEFT export usually drops them).
foreach ($extra in @('tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'chat_template.jinja')) {
    if (Test-Path -LiteralPath (Join-Path $AdapterDir $extra)) { $payloadFiles += $extra }
}

$localHashes = @{}
foreach ($f in $payloadFiles) {
    $abs = Join-Path $AdapterDir $f
    $h = (Get-FileHash -LiteralPath $abs -Algorithm SHA256).Hash.ToLower()
    $localHashes[$f] = $h
    Write-Host ("  {0}  {1}" -f $h, $f)
}

# ---------------------------------------------------------------------------
# 4. Locate rsync
# ---------------------------------------------------------------------------
# On Windows we accept three providers (in order):
#   1. native rsync.exe on PATH (cwRsync, MSYS2, scoop)
#   2. WSL rsync                (`wsl rsync ...`)
#   3. fall through to a scp-based path — but scp does NOT preserve the
#      per-file integrity that rsync's --checksum gives us, and we already
#      do a remote sha256sum verify pass, so scp fallback is acceptable.
Write-Step 'Locating rsync'

$rsyncMode = $null
$rsyncCmd = Get-Command rsync -ErrorAction SilentlyContinue
if ($rsyncCmd) {
    $rsyncMode = 'native'
    Write-Ok "rsync = $($rsyncCmd.Source)"
} elseif (Get-Command wsl -ErrorAction SilentlyContinue) {
    # Sanity: WSL must actually have rsync inside it.
    $wslHas = (wsl which rsync) 2>$null
    if ($LASTEXITCODE -eq 0 -and $wslHas) {
        $rsyncMode = 'wsl'
        Write-Ok "rsync = WSL ($($wslHas.Trim()))"
    }
}
if (-not $rsyncMode) {
    $rsyncMode = 'scp'
    Write-Warn2 'rsync not found (native or WSL). Falling back to scp.'
    Write-Warn2 'Integrity is still verified via remote sha256sum after transfer.'
}

# ---------------------------------------------------------------------------
# 5. Dry-run gate
# ---------------------------------------------------------------------------
if (-not $Confirm) {
    Write-Host ''
    Write-Warn2 'DRY RUN — no bytes will be transmitted.'
    Write-Warn2 "Re-run with -Confirm to deploy to ${codexaUser}@${codexaHost}:${codexaTarget}"
    Write-Host ''
    Write-Host 'Plan:'
    Write-Host "  1. ssh ${codexaUser}@${codexaHost} -p ${codexaPort} 'install -d -m 0755 ${codexaTarget}'"
    Write-Host "  2. ${rsyncMode} push payload ($($payloadFiles.Count) files) to ${codexaTarget}"
    Write-Host "  3. ssh ${codexaUser}@${codexaHost} 'cd ${codexaTarget} && sha256sum *' -> compare to local"
    if (-not $SkipOllamaCreate) {
        Write-Host "  4. ssh ${codexaUser}@${codexaHost} 'cd ${codexaTarget} && ollama create ${OllamaTag} -f Modelfile.ae-misfit-v0'"
    } else {
        Write-Host '  4. SKIPPED (SkipOllamaCreate)'
    }
    exit 7
}

# ---------------------------------------------------------------------------
# 6. Helper: ssh / rsync / scp invocation builders
# ---------------------------------------------------------------------------
# We pin StrictHostKeyChecking=accept-new so first-deploy doesn't hang on a
# TTY prompt, while still refusing key changes on subsequent deploys.
$sshOpts = @(
    '-i', $sshKey,
    '-p', $codexaPort,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'ServerAliveInterval=30'
)

function Invoke-RemoteSsh([string]$remoteCmd) {
    & ssh @sshOpts ("{0}@{1}" -f $codexaUser, $codexaHost) $remoteCmd
    return $LASTEXITCODE
}

function Convert-ToWslPath([string]$winPath) {
    # C:\foo\bar -> /mnt/c/foo/bar
    $p = $winPath -replace '\\', '/'
    if ($p -match '^([A-Za-z]):/(.*)$') {
        return '/mnt/' + $matches[1].ToLower() + '/' + $matches[2]
    }
    return $p
}

# ---------------------------------------------------------------------------
# 7. Ensure target dir on Codexa
# ---------------------------------------------------------------------------
Write-Step "Ensuring ${codexaTarget} exists on Codexa"
$rc = Invoke-RemoteSsh ("install -d -m 0755 '{0}'" -f $codexaTarget)
if ($rc -ne 0) {
    Write-Err2 "Failed to create remote target dir ${codexaTarget} (ssh exit ${rc})"
    Write-Err2 'Check: ssh connectivity, key permissions, and that the user can write under /opt/atomeons/adapters.'
    exit 4
}
Write-Ok 'remote target ready'

# ---------------------------------------------------------------------------
# 8. Push payload
# ---------------------------------------------------------------------------
Write-Step "Pushing payload via ${rsyncMode}"

$remoteSpec = ("{0}@{1}:{2}" -f $codexaUser, $codexaHost, $codexaTarget)

# Build a temp file-list so rsync/scp transfer exactly the files we hashed —
# no checkpoints/, no notebooks, no README.
$payloadAbs = $payloadFiles | ForEach-Object { Join-Path $AdapterDir $_ }

switch ($rsyncMode) {
    'native' {
        # Use --files-from with the source root as base. rsync's -e flag wraps ssh
        # with the same key/opts we use elsewhere.
        $listFile = New-TemporaryFile
        Set-Content -LiteralPath $listFile -Value $payloadFiles -Encoding ascii
        $sshCmdString = ("ssh -i '{0}' -p {1} -o StrictHostKeyChecking=accept-new -o BatchMode=yes" -f $sshKey, $codexaPort)
        & rsync `
            -avz `
            --checksum `
            --files-from=$listFile `
            -e $sshCmdString `
            "$AdapterDir/" `
            $remoteSpec
        $rsyncRc = $LASTEXITCODE
        Remove-Item -LiteralPath $listFile -Force
        if ($rsyncRc -ne 0) {
            Write-Err2 "rsync failed (exit ${rsyncRc})"
            exit 4
        }
    }
    'wsl' {
        $wslSrc = Convert-ToWslPath $AdapterDir
        $wslKey = Convert-ToWslPath $sshKey
        $listFile = New-TemporaryFile
        Set-Content -LiteralPath $listFile -Value $payloadFiles -Encoding ascii
        $wslList = Convert-ToWslPath $listFile.FullName
        $sshCmdString = "ssh -i '$wslKey' -p $codexaPort -o StrictHostKeyChecking=accept-new -o BatchMode=yes"
        & wsl rsync -avz --checksum --files-from="$wslList" -e "$sshCmdString" "$wslSrc/" "$remoteSpec"
        $rsyncRc = $LASTEXITCODE
        Remove-Item -LiteralPath $listFile -Force
        if ($rsyncRc -ne 0) {
            Write-Err2 "wsl rsync failed (exit ${rsyncRc})"
            exit 4
        }
    }
    'scp' {
        $scpOpts = @(
            '-i', $sshKey,
            '-P', $codexaPort,
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', 'BatchMode=yes'
        )
        foreach ($abs in $payloadAbs) {
            & scp @scpOpts $abs $remoteSpec
            if ($LASTEXITCODE -ne 0) {
                Write-Err2 ("scp failed for {0} (exit {1})" -f $abs, $LASTEXITCODE)
                exit 4
            }
        }
    }
}
Write-Ok 'payload transferred'

# ---------------------------------------------------------------------------
# 9. Verify remote sha256
# ---------------------------------------------------------------------------
# We collect remote hashes with one ssh call to minimize round-trips, parse
# `sha256sum`'s `<hash>  <name>` format, and diff against our local table.
Write-Step 'Verifying remote sha256'

$fileListShell = ($payloadFiles | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
$remoteCmd = "cd '$codexaTarget' && sha256sum $fileListShell"

$remoteOut = & ssh @sshOpts ("{0}@{1}" -f $codexaUser, $codexaHost) $remoteCmd
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "Remote sha256sum failed (exit ${LASTEXITCODE})."
    exit 5
}

$remoteHashes = @{}
foreach ($line in $remoteOut) {
    if ($line -match '^([0-9a-fA-F]{64})\s+(.+)$') {
        $remoteHashes[$matches[2].Trim()] = $matches[1].ToLower()
    }
}

$mismatch = $false
foreach ($f in $payloadFiles) {
    $loc = $localHashes[$f]
    $rem = $remoteHashes[$f]
    if (-not $rem) {
        Write-Err2 ("missing remote hash for {0}" -f $f)
        $mismatch = $true
        continue
    }
    if ($loc -ne $rem) {
        Write-Err2 ("sha256 mismatch on {0}" -f $f)
        Write-Err2 ("  local  = {0}" -f $loc)
        Write-Err2 ("  remote = {0}" -f $rem)
        $mismatch = $true
    } else {
        Write-Ok ("verified {0}" -f $f)
    }
}
if ($mismatch) {
    Write-Err2 'Integrity verification failed. The remote copy is not byte-equal to local.'
    Write-Err2 'Aborting before ollama create — refusing to register a tampered or partial adapter.'
    exit 5
}

# Drop a manifest on Codexa so the bakeoff harness can prove what shipped.
$manifestLines = @("# AE Misfit v0 deploy manifest")
$manifestLines += "# generated: $(Get-Date -Format o)"
$manifestLines += "# operator : $env:USERNAME on $env:COMPUTERNAME"
$manifestLines += "# ollama   : $OllamaTag"
foreach ($f in $payloadFiles) { $manifestLines += ("{0}  {1}" -f $localHashes[$f], $f) }
$manifestRemote = "$codexaTarget" + 'deploy-manifest.txt'
$manifestPayload = ($manifestLines -join "`n").Replace("'", "'\''")
$null = Invoke-RemoteSsh "cat > '$manifestRemote' <<'AEDEPLOY_EOF'`n$manifestPayload`nAEDEPLOY_EOF"
Write-Ok "manifest written to ${manifestRemote}"

# ---------------------------------------------------------------------------
# 10. ollama create on Codexa
# ---------------------------------------------------------------------------
if ($SkipOllamaCreate) {
    Write-Warn2 '-SkipOllamaCreate set; not registering the model in Ollama.'
    Write-Ok 'deploy complete (staging only)'
    exit 0
}

Write-Step "Registering ${OllamaTag} in Ollama on Codexa"
$ollamaCmd = "cd '$codexaTarget' && ollama create '$OllamaTag' -f Modelfile.ae-misfit-v0"
$rc = Invoke-RemoteSsh $ollamaCmd
if ($rc -ne 0) {
    Write-Err2 "ollama create failed on Codexa (exit ${rc})."
    Write-Err2 'Common causes:'
    Write-Err2 '  - ollama version too old to support ADAPTER directive (need >= 0.1.40)'
    Write-Err2 '  - base model unsloth/qwen2.5:7b not pulled on Codexa'
    Write-Err2 "    fix: ssh ${codexaUser}@${codexaHost} 'ollama pull unsloth/qwen2.5:7b'"
    Write-Err2 '  - adapter.safetensors not in PEFT-LoRA format readable by ollama'
    exit 6
}

Write-Ok ("registered ${OllamaTag}")
Write-Ok ''
Write-Ok 'AE Misfit v0 is live on Codexa.'
Write-Ok 'Next: run the bakeoff harness against stock qwen2.5:7b on the 100-pair refusal corpus.'
Write-Ok '  node second-opinion.mjs --bakeoff --challenger ae-misfit:v0 --baseline qwen2.5:7b'
exit 0
