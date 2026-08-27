param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\apps\desktop\vendor\node')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$version = 'v22.18.0'
$archiveName = 'node-v22.18.0-win-x64.zip'
$archiveSha256 = 'c95d8a7e1c99e669cc08c9f1176e068c1f50847c37908fcb8c35b62482366511'
$downloadUrl = "https://nodejs.org/dist/$version/$archiveName"
$archiveRoot = 'node-v22.18.0-win-x64/'
$expectedFiles = [ordered]@{
  'node.exe' = 'c22d1c59a1f767a1ed0178445a027f2257d318c55430fc819d48f269586822b7'
  'LICENSE' = '2a40a9b2f0840d2f53cec4bb4d4a1e23f22ce67ded24b245c212e41f066a2ff2'
  'README.md' = '1452a54a889e7548ad793aef4f86850ae66d5a85d833732dace9fbf7a431d5ae'
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
    if ((Get-Sha256 $filePath) -ne $entry.Value) { return $false }
  }
  return $true
}

$resolvedDestination = [System.IO.Path]::GetFullPath($Destination)
if (Test-VerifiedDirectory $resolvedDestination) {
  Write-Output "Node.js $version ya esta preparado y verificado."
  return
}
if (Test-Path -LiteralPath $resolvedDestination) {
  throw "El destino existe pero no coincide con el runtime fijado: $resolvedDestination"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('localbridge-node-' + [guid]::NewGuid().ToString('N'))
$resolvedTemporaryRoot = [System.IO.Path]::GetFullPath($temporaryRoot)
$resolvedSystemTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
if (-not $resolvedTemporaryRoot.StartsWith($resolvedSystemTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'El directorio temporal quedo fuera del area temporal del sistema.'
}

New-Item -ItemType Directory -Path $resolvedTemporaryRoot | Out-Null
$archivePath = Join-Path $resolvedTemporaryRoot $archiveName
$expandedPath = Join-Path $resolvedTemporaryRoot 'runtime'
New-Item -ItemType Directory -Path $expandedPath | Out-Null

try {
  Invoke-WebRequest -UseBasicParsing -Uri $downloadUrl -OutFile $archivePath
  if ((Get-Sha256 $archivePath) -ne $archiveSha256) {
    throw "Checksum invalido para $archiveName"
  }

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    foreach ($entry in $expectedFiles.GetEnumerator()) {
      $archivePathName = $archiveRoot + $entry.Key
      $matches = @($zip.Entries | Where-Object { $_.FullName -eq $archivePathName })
      if ($matches.Count -ne 1) {
        throw "El ZIP no contiene una unica entrada permitida para $archivePathName"
      }
      if ($matches[0].Length -gt 128MB) {
        throw "Entrada desproporcionada en el ZIP: $archivePathName"
      }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile(
        $matches[0],
        (Join-Path $expandedPath $entry.Key),
        $false
      )
    }
  } finally {
    $zip.Dispose()
  }

  if (-not (Test-VerifiedDirectory $expandedPath)) {
    throw 'Los archivos extraidos no coinciden con la allowlist de hashes.'
  }

  $destinationParent = Split-Path -Parent $resolvedDestination
  New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  Move-Item -LiteralPath $expandedPath -Destination $resolvedDestination
  Write-Output "Node.js $version preparado y verificado en $resolvedDestination"
} finally {
  if (Test-Path -LiteralPath $resolvedTemporaryRoot) {
    Remove-Item -LiteralPath $resolvedTemporaryRoot -Recurse -Force
  }
}
