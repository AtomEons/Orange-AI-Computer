#!/usr/bin/env pwsh
# Windows cleanup script for Atomic Chat.

[CmdletBinding()]
param(
    [string]$IsNightly = 'false',
    [switch]$ConfirmDestruction
)

$ErrorActionPreference = 'Stop'

function Resolve-CleanupRoot {
    param([string]$Name, [string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "Refusing cleanup: $Name is not set."
    }

    $fullPath = [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@('\', '/'))
    $volumeRoot = [IO.Path]::GetPathRoot($fullPath).TrimEnd([char[]]@('\', '/'))
    if ([string]::Equals($fullPath, $volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup: $Name resolves to a filesystem root."
    }
    return $fullPath
}

function Resolve-AllowedCleanupPath {
    param(
        [string]$Root,
        [string]$RelativePath,
        [string[]]$AllowedRelativePaths
    )

    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -cnotin $AllowedRelativePaths) {
        throw "Refusing cleanup path outside the allowlist: $RelativePath"
    }

    $fullPath = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    $rootPrefix = $Root.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing cleanup path outside its allowed root: $fullPath"
    }
    return $fullPath
}

function Invoke-AllowedRemoval {
    param([string]$Path, [switch]$Recurse)

    if (-not $ConfirmDestruction) {
        Write-Host "[DRY-RUN] Would remove: $Path"
        return
    }
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse:$Recurse -Force
    }
}

$appDataRoot = Resolve-CleanupRoot 'APPDATA' $env:APPDATA
$localAppDataRoot = Resolve-CleanupRoot 'LOCALAPPDATA' $env:LOCALAPPDATA
$userProfileRoot = Resolve-CleanupRoot 'USERPROFILE' $env:USERPROFILE

$targets = @(
    [pscustomobject]@{ Path = Resolve-AllowedCleanupPath $appDataRoot 'Jan' @('Jan', 'Jan-nightly'); Recurse = $true }
    [pscustomobject]@{ Path = Resolve-AllowedCleanupPath $appDataRoot 'Jan-nightly' @('Jan', 'Jan-nightly'); Recurse = $true }
    [pscustomobject]@{ Path = Resolve-AllowedCleanupPath $localAppDataRoot 'jan.ai.app' @('jan.ai.app', 'jan-nightly.ai.app'); Recurse = $true }
    [pscustomobject]@{ Path = Resolve-AllowedCleanupPath $localAppDataRoot 'jan-nightly.ai.app' @('jan.ai.app', 'jan-nightly.ai.app'); Recurse = $true }
    [pscustomobject]@{ Path = Resolve-AllowedCleanupPath $userProfileRoot 'jan\extensions' @('jan\extensions'); Recurse = $true }
)

if (-not $ConfirmDestruction) {
    Write-Host '[DRY-RUN] Pass -ConfirmDestruction to execute this cleanup.'
    foreach ($processName in @('Jan', 'jan', 'Jan-nightly', 'jan-nightly')) {
        Write-Host "[DRY-RUN] Would stop exact process: $processName"
    }
} else {
    foreach ($processName in @('Jan', 'jan', 'Jan-nightly', 'jan-nightly')) {
        Get-Process -Name $processName -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
    }
}

foreach ($target in $targets) {
    Invoke-AllowedRemoval -Path $target.Path -Recurse:$target.Recurse
}

if ($ConfirmDestruction) {
    Write-Host 'Atomic Chat cleanup completed'
}
