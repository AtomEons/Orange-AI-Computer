param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
$files = Get-ChildItem -LiteralPath $Root -Recurse -Filter '*.ps1'
$failures = @()
foreach ($file in $files) {
  $tokens = $null
  $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors)
  if ($errors.Count) {
    $failures += [ordered]@{ file = $file.FullName; errors = @($errors | ForEach-Object { $_.Message }) }
  }
}
if ($failures.Count) {
  $failures | ConvertTo-Json -Depth 8
  exit 1
}
"PowerShell syntax PASS ($($files.Count) files)"
