param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\apps\desktop\vendor\tunnel-client')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$version = 'v0.0.12'
$archiveName = 'tunnel-client-v0.0.12-windows-amd64.zip'
$archiveSha256 = '2a2804933924e38a502d62b61f0266cb80d56d65744f4c29876b2bf9c1544356'
$checksumManifestSha256 = 'a485021fe13a947c013943065e58f85462262741542e81f15de51e7ff1509812'
$downloadUrl = "https://github.com/openai/tunnel-client/releases/download/$version/$archiveName"
$checksumManifestUrl = "https://github.com/openai/tunnel-client/releases/download/$version/SHA256SUMS.txt"

$expectedFiles = [ordered]@{
  'cloudflared-manifest.json' = '149c1b5c0095ffab41c3986d620ca18c35373e05c5b6ca0bea88ac19f6d4a7a5'
  'cloudflared.exe' = 'c8405b5b4b92d2529202aeca634a3aa6ecdaa231f42238293e4a8a755bd6c1ff'
  'LICENSE' = 'f4c1d7ba32ef5bcf5cf03e2eefec5825ebafedf50fa330a36700a49c605c1ef4'
  'NOTICE' = '1364c020d86ecf948b78b7c655175032068203d13aece70fb0bfe112d7802dc2'
  'tunnel-client-v0.0.12-windows-amd64-licenses.txt' = '7d85227df86c38a689fca913d6f4a0b49ad030d6e056155a6832312cf7fb4bad'
  'tunnel-client-v0.0.12-windows-amd64.spdx.json' = '4c6b46a645b71853d55f50cfb4b2c51324422a57f007984ba113d3edcfeb4f2c'
  'tunnel-client.exe' = '6649169733686805ca16cccd91774594d0c017fd729c37ad4ce1cd18323d9ae8'
}

function Get-Sha256([string]$Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $sha256.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $sha256.Dispose()
    $stream.Dispose()
  }
}

function Test-VerifiedDirectory([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }

  $actualFiles = @(Get-ChildItem -LiteralPath $Path -File)
  if ($actualFiles.Count -ne $expectedFiles.Count) { return $false }

  foreach ($entry in $expectedFiles.GetEnumerator()) {
    $filePath = Join-Path $Path $entry.Key
    if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) { return $false }
    $actualHash = Get-Sha256 $filePath
    if ($actualHash -ne $entry.Value) { return $false }
  }

  return $true
}

$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
if (Test-VerifiedDirectory $resolvedDestination) {
  Write-Output "tunnel-client $version ya esta preparado y verificado."
  return
}

if (Test-Path -LiteralPath $resolvedDestination) {
  throw "El destino existe pero no coincide con el artefacto fijado: $resolvedDestination"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('localbridge-tunnel-' + [guid]::NewGuid().ToString('N'))
$resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
$resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $resolvedTemporaryRoot.StartsWith($resolvedSystemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'El directorio temporal quedó fuera del área temporal del sistema.'
}

New-Item -ItemType Directory -Path $resolvedTemporaryRoot | Out-Null
$archivePath = Join-Path $resolvedTemporaryRoot $archiveName
$checksumManifestPath = Join-Path $resolvedTemporaryRoot 'SHA256SUMS.txt'
$expandedPath = Join-Path $resolvedTemporaryRoot 'expanded'

try {
  Invoke-WebRequest -UseBasicParsing -Uri $checksumManifestUrl -OutFile $checksumManifestPath
  if ((Get-Sha256 $checksumManifestPath) -ne $checksumManifestSha256) {
    throw 'Checksum invalido para el manifiesto SHA256SUMS.txt'
  }
  $manifestLine = Get-Content -LiteralPath $checksumManifestPath | Where-Object { $_ -match "  $([regex]::Escape($archiveName))$" }
  if (@($manifestLine).Count -ne 1 -or -not $manifestLine.StartsWith($archiveSha256)) {
    throw "El manifiesto oficial no contiene el hash fijado de $archiveName"
  }

  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
  $actualArchiveHash = Get-Sha256 $archivePath
  if ($actualArchiveHash -ne $archiveSha256) {
    throw "Checksum inválido para $archiveName"
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    $entries = @($zip.Entries)
    if ($entries.Count -ne $expectedFiles.Count) {
      throw "El ZIP contiene $($entries.Count) entradas; se esperaban $($expectedFiles.Count)."
    }
    foreach ($entry in $entries) {
      if (-not $expectedFiles.Contains($entry.FullName) -or $entry.Name -ne $entry.FullName) {
        throw "Entrada no permitida en el ZIP: $($entry.FullName)"
      }
      if ($entry.Length -gt 64MB) {
        throw "Entrada desproporcionada en el ZIP: $($entry.FullName)"
      }
    }
  } finally {
    $zip.Dispose()
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $expandedPath
  if (-not (Test-VerifiedDirectory $expandedPath)) {
    throw 'Los archivos extraídos no coinciden con la allowlist de hashes.'
  }

  $destinationParent = Split-Path -Parent $resolvedDestination
  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  Move-Item -LiteralPath $expandedPath -Destination $resolvedDestination
  Write-Output "tunnel-client $version preparado y verificado en $resolvedDestination"
} finally {
  if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
  }
}
