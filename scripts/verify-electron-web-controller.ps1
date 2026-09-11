$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$outputRoot = Join-Path $workspaceRoot 'dist/web-controller-test'
$entryPath = Join-Path $outputRoot 'index.cjs'
$stdoutPath = Join-Path $outputRoot 'verify.stdout.log'
$stderrPath = Join-Path $outputRoot 'verify.stderr.log'
$electronPath = Join-Path $workspaceRoot 'apps/desktop/node_modules/electron/dist/electron.exe'

Push-Location $workspaceRoot
try {
    pnpm --filter '@localbridge/desktop' exec vite build --config '../../scripts/vite.web-controller-test.config.ts'
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw "Electron web verifier bundle is missing: $entryPath" }
    if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) { throw "Electron runtime is missing: $electronPath" }

    Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $electronPath -ArgumentList @($entryPath) -WorkingDirectory $workspaceRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
    $nativeHandle = $process.Handle
    try {
        if (-not $process.WaitForExit(60000)) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            throw 'Electron web verification exceeded 60 seconds.'
        }
        $process.WaitForExit()
        $process.Refresh()
        if ($process.ExitCode -ne 0) {
            $diagnostic = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '<stderr unavailable>' }
            throw "Electron web verification failed with exit code $($process.ExitCode).`n$diagnostic"
        }
    } finally {
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    Get-Content -LiteralPath $stdoutPath
} finally {
    Pop-Location
}
