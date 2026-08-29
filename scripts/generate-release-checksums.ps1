param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedDirectory = [IO.Path]::GetFullPath($ReleaseDirectory)
if (-not (Test-Path -LiteralPath $resolvedDirectory -PathType Container)) {
  throw "Release directory does not exist: $resolvedDirectory"
}

$installers = @(Get-ChildItem -LiteralPath $resolvedDirectory -Filter "*Setup $Version.exe" -File)
if ($installers.Count -ne 1) {
  throw "Expected exactly one installer for $Version; found $($installers.Count)."
}
$requiredNames = @(
  $installers[0].Name,
  "$($installers[0].Name).blockmap",
  "localbridge-v$Version.spdx.json"
)
$artifacts = foreach ($name in $requiredNames) {
  $artifactPath = Join-Path $resolvedDirectory $name
  if (-not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
    throw "Missing release artifact: $name"
  }
  Get-Item -LiteralPath $artifactPath
}
$artifacts = @($artifacts | Sort-Object Name)

$lines = foreach ($artifact in $artifacts) {
  $stream = [IO.File]::OpenRead($artifact.FullName)
  try {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try {
      $hash = -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
      $algorithm.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
  $publishedName = $artifact.Name.Replace(' ', '.')
  "$hash  $publishedName"
}

$outputPath = Join-Path $resolvedDirectory 'SHA256SUMS.txt'
[IO.File]::WriteAllLines($outputPath, $lines, [Text.UTF8Encoding]::new($false))
Write-Output $outputPath
