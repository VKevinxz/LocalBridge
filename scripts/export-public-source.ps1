[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Destination
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$destinationRoot = [IO.Path]::GetFullPath($Destination)
$comparison = [StringComparison]::OrdinalIgnoreCase
if ($destinationRoot.Equals($repoRoot, $comparison) -or
    $repoRoot.StartsWith($destinationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, $comparison)) {
    throw 'Destination must not be the repository root or one of its parents.'
}
if (Test-Path -LiteralPath $destinationRoot) {
    if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
        throw 'Destination exists and is not a directory.'
    }
    if (@(Get-ChildItem -LiteralPath $destinationRoot -Force).Count -gt 0) {
        throw 'Destination must be absent or empty; existing files are never overwritten.'
    }
} else {
    New-Item -ItemType Directory -Path $destinationRoot | Out-Null
}

$manifestPath = Join-Path $repoRoot 'public-snapshot.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1) {
    throw 'Unsupported public snapshot manifest version.'
}

$excludedDirectories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@($manifest.excludedDirectoryNames) | ForEach-Object { [void]$excludedDirectories.Add([string]$_) }
$excludedExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@($manifest.excludedExtensions) | ForEach-Object { [void]$excludedExtensions.Add([string]$_) }
$copied = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)

function Get-RepoRelativePath {
    param([Parameter(Mandatory = $true)][string]$FullPath)

    $full = [IO.Path]::GetFullPath($FullPath)
    $prefix = $repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $full.StartsWith($prefix, $comparison)) {
        throw 'Source file is outside the repository.'
    }
    return $full.Substring($prefix.Length)
}

function Copy-PublicFile {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    $normalized = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    if ([IO.Path]::IsPathRooted($normalized) -or $normalized.Split([IO.Path]::DirectorySeparatorChar) -contains '..') {
        throw "Public manifest contains an unsafe path: $RelativePath"
    }
    $sourcePath = [IO.Path]::GetFullPath((Join-Path $repoRoot $normalized))
    if (-not $sourcePath.StartsWith($repoRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, $comparison)) {
        throw "Public path escapes the repository: $RelativePath"
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "Public source file is missing: $RelativePath"
    }
    $item = Get-Item -LiteralPath $sourcePath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Public source file must not be a reparse point: $RelativePath"
    }
    $targetPath = Join-Path $destinationRoot $normalized
    $targetDirectory = Split-Path -Parent $targetPath
    New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath
    [void]$copied.Add($RelativePath.Replace('\', '/'))
}

@($manifest.rootFiles) | ForEach-Object { Copy-PublicFile -RelativePath ([string]$_) }
@($manifest.publicDocs) | ForEach-Object { Copy-PublicFile -RelativePath ([string]$_) }

foreach ($directory in @($manifest.sourceDirectories)) {
    $relativeDirectory = [string]$directory
    $sourceDirectory = Join-Path $repoRoot $relativeDirectory
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        throw "Public source directory is missing: $relativeDirectory"
    }
    foreach ($file in Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File -Force) {
        $relative = Get-RepoRelativePath -FullPath $file.FullName
        $segments = $relative.Split([IO.Path]::DirectorySeparatorChar)
        if (@($segments | Where-Object { $excludedDirectories.Contains($_) }).Count -gt 0) { continue }
        if ($excludedExtensions.Contains($file.Extension)) { continue }
        if (($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
        Copy-PublicFile -RelativePath $relative
    }
}

$auditScript = Join-Path $destinationRoot 'scripts/audit-public-snapshot.ps1'
& $auditScript -Path $destinationRoot

Write-Output "Public snapshot created at $destinationRoot with $($copied.Count) file(s)."
Write-Output 'The snapshot has no Git history and preserves the approved UNLICENSED/VKevinXZ publication metadata.'
