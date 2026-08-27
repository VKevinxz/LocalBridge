$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$version = '1.7.12'
$archiveName = "actionlint_${version}_windows_amd64.zip"
$expectedSha256 = '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9'
$downloadUrl = "https://github.com/rhysd/actionlint/releases/download/v$version/$archiveName"
$toolRoot = Join-Path ([IO.Path]::GetTempPath()) "localbridge-actionlint-$version-$PID"
$archivePath = Join-Path $toolRoot $archiveName
$executablePath = Join-Path $toolRoot 'actionlint.exe'

New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
Invoke-WebRequest -Uri $downloadUrl -OutFile $archivePath

$stream = [IO.File]::OpenRead($archivePath)
try {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $actualSha256 = -join ($algorithm.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $algorithm.Dispose()
  }
} finally {
  $stream.Dispose()
}
if ($actualSha256 -ne $expectedSha256) {
  throw 'actionlint archive checksum mismatch.'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
  $entry = $archive.GetEntry('actionlint.exe')
  if ($null -eq $entry -or $entry.Length -le 0) {
    throw 'actionlint.exe is missing from the verified archive.'
  }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $executablePath, $true)
} finally {
  $archive.Dispose()
}

& $executablePath -version
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $executablePath
exit $LASTEXITCODE
