$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $workspaceRoot 'apps\desktop\node_modules\electron\dist\electron.exe'
$fixtureScript = Join-Path $PSScriptRoot 'verify-electron-key-persistence.cjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("localbridge-key-persistence-" + [guid]::NewGuid().ToString('N'))

if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw "Electron no está preparado en $electronPath"
}

New-Item -ItemType Directory -Path $testRoot | Out-Null
$previousRoot = $env:LOCALBRIDGE_KEY_PERSISTENCE_TEST_ROOT
try {
    $env:LOCALBRIDGE_KEY_PERSISTENCE_TEST_ROOT = $testRoot
    $writeProcess = Start-Process -FilePath $electronPath -ArgumentList @($fixtureScript, 'write') -WindowStyle Hidden -Wait -PassThru
    if ($writeProcess.ExitCode -ne 0) { throw "La fase de escritura safeStorage falló con exit $($writeProcess.ExitCode)" }
    $readProcess = Start-Process -FilePath $electronPath -ArgumentList @($fixtureScript, 'read') -WindowStyle Hidden -Wait -PassThru
    if ($readProcess.ExitCode -ne 0) { throw "La fase de lectura safeStorage falló con exit $($readProcess.ExitCode)" }
    Write-Output 'Electron safeStorage restart verification passed.'
} finally {
    $env:LOCALBRIDGE_KEY_PERSISTENCE_TEST_ROOT = $previousRoot
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $resolvedTemp = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
        if (-not $resolvedRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Se rechazó limpiar una ruta fuera de TEMP: $resolvedRoot"
        }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
