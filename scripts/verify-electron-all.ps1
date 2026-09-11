$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptsRoot = $PSScriptRoot
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-development.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-browser-controller.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-web-controller.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
