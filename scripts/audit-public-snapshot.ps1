[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = [IO.Path]::GetFullPath($Path)
if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw 'Snapshot directory does not exist.'
}
if (Test-Path -LiteralPath (Join-Path $root '.git')) {
    throw 'A public snapshot must not inherit Git history.'
}

$forbiddenNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.env', 'desktop-settings.json', 'tunnel-key.enc', 'workspaces.json') |
    ForEach-Object { [void]$forbiddenNames.Add($_) }
$forbiddenExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.db', '.exe', '.key', '.p12', '.pem', '.pfx', '.zip') |
    ForEach-Object { [void]$forbiddenExtensions.Add($_) }
$internalDocPattern = '(?i)(^|/)(STATUS|MASTER_SPEC|PUBLICATION_AUDIT|RELEASE_CHECKLIST|GITHUB_SETUP|ROADMAP_PRODUCTO|TEST_PLAN|.*(?:_PLAN|_ANALYSIS|_COMPLETION_AUDIT|_TEST_GUIDE))\.md$|(^|/)docs/adr/'
$secretPattern = '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})'
$textExtensions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('.c', '.cmd', '.css', '.html', '.js', '.json', '.md', '.mjs', '.mts', '.ps1', '.ts', '.tsx', '.txt', '.yml', '.yaml') |
    ForEach-Object { [void]$textExtensions.Add($_) }
$allowedSyntheticSecretFiles = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
@('tests/helpers/fixtures.ts') | ForEach-Object { [void]$allowedSyntheticSecretFiles.Add($_) }
$findings = [Collections.Generic.List[string]]::new()
$rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

foreach ($file in Get-ChildItem -LiteralPath $root -Recurse -File -Force) {
    $full = [IO.Path]::GetFullPath($file.FullName)
    if (-not $full.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        $findings.Add("file escapes snapshot root: $($file.Name)")
        continue
    }
    $relative = $full.Substring($rootPrefix.Length).Replace('\', '/')
    if ($forbiddenNames.Contains($file.Name) -or $forbiddenExtensions.Contains($file.Extension)) {
        $findings.Add("forbidden artifact: $relative")
    }
    if ($relative -match $internalDocPattern) {
        $findings.Add("internal documentation: $relative")
    }
    if ($textExtensions.Contains($file.Extension) -and -not $allowedSyntheticSecretFiles.Contains($relative)) {
        $content = Get-Content -LiteralPath $file.FullName -Raw
        if ($content -match $secretPattern) {
            $findings.Add("possible secret material: $relative")
        }
    }
}

$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$required = @(
    'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'COPYRIGHT.md', 'SECURITY.md', 'SUPPORT.md',
    'docs/GETTING_STARTED.md', 'docs/USER_GUIDE.md', 'docs/DOWNLOADS.md',
    'docs/GITHUB_PUBLISHING.md', 'docs/WINDOWS_INSTALLATION.md',
    'docs/ARCHITECTURE.md', 'docs/DESIGN_PRINCIPLES.md', 'docs/SECURITY_MODEL.md',
    "docs/releases/v$($manifest.version).md"
)
foreach ($relative in $required) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $relative) -PathType Leaf)) {
        $findings.Add("required public file missing: $relative")
    }
}

if ($findings.Count -gt 0) {
    $findings | ForEach-Object { Write-Error $_ }
    throw 'Public snapshot audit failed.'
}

Write-Output "Public snapshot audit passed across $(@(Get-ChildItem -LiteralPath $root -Recurse -File -Force).Count) file(s)."
