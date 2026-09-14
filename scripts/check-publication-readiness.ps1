[CmdletBinding()]
param(
    [string]$RootPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ([string]::IsNullOrWhiteSpace($RootPath)) {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'Cannot resolve the repository root because PSScriptRoot is unavailable.'
    }
    $RootPath = Split-Path -Parent $PSScriptRoot
}

$root = [IO.Path]::GetFullPath($RootPath)
$rootManifestPath = Join-Path $root 'package.json'
$desktopManifestPath = Join-Path $root 'apps/desktop/package.json'
$rootManifest = Get-Content -LiteralPath $rootManifestPath -Raw | ConvertFrom-Json
$desktopManifest = Get-Content -LiteralPath $desktopManifestPath -Raw | ConvertFrom-Json
$blockers = [Collections.Generic.List[string]]::new()
$declaredLicense = if ($null -eq $rootManifest.PSObject.Properties['license']) { '' } else { [string]$rootManifest.license }
$declaredAuthor = if ($null -eq $desktopManifest.PSObject.Properties['author']) { '' } else { [string]$desktopManifest.author }
$rootAuthor = if ($null -eq $rootManifest.PSObject.Properties['author']) { '' } else { [string]$rootManifest.author }
$officialRepository = 'git+https://github.com/VKevinxz/LocalBridge.git'
$officialHomepage = 'https://github.com/VKevinxz/LocalBridge#readme'
$officialIssues = 'https://github.com/VKevinxz/LocalBridge/issues'
$copyrightPath = Join-Path $root 'COPYRIGHT.md'
$licensePath = Join-Path $root 'LICENSE'

if ($declaredLicense -ne 'UNLICENSED') {
    $blockers.Add('Root package must explicitly declare license UNLICENSED.')
}
if (Test-Path -LiteralPath $licensePath) {
    $blockers.Add('LICENSE must be absent while the repository is intentionally UNLICENSED.')
}
if (-not (Test-Path -LiteralPath $copyrightPath -PathType Leaf)) {
    $blockers.Add('COPYRIGHT.md is required for the source-visible UNLICENSED publication.')
} else {
    $copyright = Get-Content -LiteralPath $copyrightPath -Raw
    if ($copyright -notmatch [regex]::Escape('VKevinXZ') -or
        $copyright -notmatch '(?i)all rights reserved' -or
        $copyright -notmatch '(?i)without an open-source license') {
        $blockers.Add('COPYRIGHT.md does not state the approved owner and no-open-source-license posture.')
    }
}
if ($declaredAuthor -ne 'VKevinXZ' -or $rootAuthor -ne 'VKevinXZ') {
    $blockers.Add('Root and desktop publisher metadata must be VKevinXZ.')
}
foreach ($manifestEntry in @(
    @{ Name = 'Root'; Manifest = $rootManifest },
    @{ Name = 'Desktop'; Manifest = $desktopManifest }
)) {
    $manifest = $manifestEntry.Manifest
    if ([string]$manifest.repository.url -ne $officialRepository -or
        [string]$manifest.homepage -ne $officialHomepage -or
        [string]$manifest.bugs.url -ne $officialIssues) {
        $blockers.Add("$($manifestEntry.Name) package metadata must point to the official VKevinxz/LocalBridge repository.")
    }
}

$packageManifests = @(
    $rootManifestPath,
    (Join-Path $root 'apps/desktop/package.json'),
    (Join-Path $root 'apps/server/package.json')
) + @(Get-ChildItem -LiteralPath (Join-Path $root 'packages') -Directory | ForEach-Object {
    Join-Path $_.FullName 'package.json'
})
foreach ($manifestPath in $packageManifests) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $license = if ($null -eq $manifest.PSObject.Properties['license']) { '' } else { [string]$manifest.license }
    if ($license -ne 'UNLICENSED' -or $manifest.private -ne $true) {
        $relative = $manifestPath.Substring($root.TrimEnd([IO.Path]::DirectorySeparatorChar).Length).TrimStart([IO.Path]::DirectorySeparatorChar)
        $blockers.Add("$relative must remain private and UNLICENSED.")
    }
}
if ($rootManifest.version -ne $desktopManifest.version) {
    $blockers.Add('Root and desktop package versions do not match.')
}
$releaseNote = Join-Path $root "docs/releases/v$($rootManifest.version).md"
if (-not (Test-Path -LiteralPath $releaseNote -PathType Leaf)) {
    $blockers.Add("Missing release note docs/releases/v$($rootManifest.version).md.")
}
$readme = Get-Content -LiteralPath (Join-Path $root 'README.md') -Raw
if ($readme -match 'OWNER/REPOSITORY|<cuenta>|<repositorio>|TODO_PUBLIC' -or
    $readme -notmatch [regex]::Escape('https://github.com/VKevinxz/LocalBridge')) {
    $blockers.Add('README contains unresolved publication placeholders.')
}

if ($blockers.Count -gt 0) {
    $blockers | ForEach-Object { Write-Output "BLOCKER: $_" }
    throw "Publication readiness failed with $($blockers.Count) blocker(s)."
}

Write-Output "Publication metadata is ready for v$($rootManifest.version)."
