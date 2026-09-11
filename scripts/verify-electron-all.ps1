$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$scriptsRoot = $PSScriptRoot
$workspaceRoot = Split-Path -Parent $scriptsRoot
Push-Location $workspaceRoot
try {
    # Electron 43 descarga su binario bajo demanda; pnpm install no crea dist.
    # Usamos el instalador del paquete fijado por el lockfile antes del acceso directo.
    pnpm --filter '@localbridge/desktop' exec install-electron
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'prepare-node-runtime.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'build-windows-process-host.ps1')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-development.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-browser-controller.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $scriptsRoot 'verify-electron-web-controller.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
