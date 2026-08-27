param(
  [string]$Destination = (Join-Path $PSScriptRoot '..\apps\desktop\vendor\process-host')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ZigVersion = '0.16.0'
$ZigUrl = "https://ziglang.org/download/$ZigVersion/zig-x86_64-windows-$ZigVersion.zip"
$ZigSha256 = '68659eb5f1e4eb1437a722f1dd889c5a322c9954607f5edcf337bc3684a75a7e'
$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\native\windows-process-host.c')).Path
$ResolvedDestination = [System.IO.Path]::GetFullPath($Destination)
$BuildCache = Join-Path $env:LOCALAPPDATA "LocalBridgeBuild\zig-$ZigVersion"
$ZigBinary = Join-Path $BuildCache 'zig.exe'

function Get-Sha256Hex([string]$Path) {
  $Stream = [System.IO.File]::OpenRead($Path)
  try {
    $Algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
      return -join ($Algorithm.ComputeHash($Stream) | ForEach-Object { $_.ToString('x2') })
    } finally {
      $Algorithm.Dispose()
    }
  } finally {
    $Stream.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $ZigBinary -PathType Leaf)) {
  $TempRoot = Join-Path $env:TEMP ("localbridge-zig-" + [guid]::NewGuid().ToString('N'))
  $ZipPath = Join-Path $TempRoot 'zig.zip'
  $ExtractRoot = Join-Path $TempRoot 'extract'
  New-Item -ItemType Directory -Path $ExtractRoot -Force | Out-Null
  try {
    Invoke-WebRequest -Uri $ZigUrl -OutFile $ZipPath
    $ActualHash = Get-Sha256Hex $ZipPath
    if ($ActualHash -ne $ZigSha256) {
      throw "El SHA-256 de Zig no coincide: $ActualHash"
    }
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $ExtractRoot
    $Extracted = Join-Path $ExtractRoot "zig-x86_64-windows-$ZigVersion"
    if (-not (Test-Path -LiteralPath (Join-Path $Extracted 'zig.exe') -PathType Leaf)) {
      throw 'El ZIP oficial de Zig no contiene zig.exe en la ruta esperada.'
    }
    $CacheParent = Split-Path -Parent $BuildCache
    New-Item -ItemType Directory -Path $CacheParent -Force | Out-Null
    if (Test-Path -LiteralPath $BuildCache) {
      $ResolvedCache = [System.IO.Path]::GetFullPath($BuildCache)
      $ResolvedParent = [System.IO.Path]::GetFullPath($CacheParent)
      if (-not $ResolvedCache.StartsWith($ResolvedParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'La caché de Zig quedó fuera del directorio de build permitido.'
      }
      Remove-Item -LiteralPath $ResolvedCache -Recurse -Force
    }
    Move-Item -LiteralPath $Extracted -Destination $BuildCache
  } finally {
    if (Test-Path -LiteralPath $TempRoot) {
      Remove-Item -LiteralPath $TempRoot -Recurse -Force
    }
  }
}

New-Item -ItemType Directory -Path $ResolvedDestination -Force | Out-Null
$Output = Join-Path $ResolvedDestination 'localbridge-process-host.exe'
& $ZigBinary cc $Source -target x86_64-windows-gnu -O2 -s -municode '-Wl,--subsystem,console' -liphlpapi -lws2_32 -o $Output
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) {
  throw 'No se pudo compilar localbridge-process-host.exe.'
}

$OutputHash = (Get-Sha256Hex $Output).ToUpperInvariant()
Set-Content -LiteralPath (Join-Path $ResolvedDestination 'SHA256SUMS.txt') -Value "$OutputHash  localbridge-process-host.exe" -Encoding ascii
Set-Content -LiteralPath (Join-Path $ResolvedDestination 'NOTICE.txt') -Value @(
  'LocalBridge Windows process host'
  "Built from native/windows-process-host.c with Zig $ZigVersion."
  "Compiler archive SHA-256: $ZigSha256"
) -Encoding utf8

Write-Host "Proceso host compilado: $Output"
Write-Host "SHA-256: $OutputHash"
