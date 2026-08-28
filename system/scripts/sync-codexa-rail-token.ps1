param(
  [string]$HostName = '10.0.0.4',
  [string]$UserName = 'Atom',
  [string]$IdentityFile = (Join-Path $env:USERPROFILE '.ssh\orange_codexa_automation_ed25519')
)

$ErrorActionPreference = 'Stop'
$ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
$remotePath = 'C:\AtomEons\ai-box\orangebox-command-rail\ORANGEBOX_AI_BOX_COMMAND_TOKEN.txt'
$secretDir = Join-Path $env:USERPROFILE 'OrangeBox-Data\orange5\secrets'
$secretPath = Join-Path $secretDir 'rail-token.txt'

$token = (& $ssh '-o' 'BatchMode=yes' '-o' 'ConnectTimeout=15' '-i' $IdentityFile `
  "$UserName@$HostName" 'cmd.exe' '/d' '/c' 'type' $remotePath 2>$null | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
  throw 'Could not read the canonical Codexa rail token through authenticated SSH.'
}
if ($token -match '[\r\n]' -or $token.Length -lt 24) {
  throw 'Codexa returned an invalid rail token payload.'
}

New-Item -ItemType Directory -Force -Path $secretDir | Out-Null
Set-Content -LiteralPath $secretPath -Value $token -NoNewline -Encoding utf8
[Environment]::SetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN', $token, 'User')
[Environment]::SetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN_FILE', $secretPath, 'User')

$principal = "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $secretPath '/inheritance:r' '/grant:r' "${principal}:F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the local rail-token file ACL.' }

$sha256 = [Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
} finally {
  $sha256.Dispose()
}
$hash = ([BitConverter]::ToString($hashBytes) -replace '-', '').ToLowerInvariant()
[ordered]@{
  schema = 'orangefive.rail-token-sync.v1'
  status = 'VERIFIED'
  host = $HostName
  path = $secretPath
  sha256Prefix = $hash.Substring(0, 16)
  userEnvironmentUpdated = $true
} | ConvertTo-Json -Depth 4
