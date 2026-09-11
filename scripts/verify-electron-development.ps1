$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $workspaceRoot 'apps/desktop/node_modules/electron/dist/electron.exe'
$helperPath = Join-Path $workspaceRoot 'apps/desktop/vendor/process-host/localbridge-process-host.exe'
$nodePath = Join-Path $workspaceRoot 'apps/desktop/vendor/node/node.exe'
$vitePath = Join-Path $workspaceRoot 'apps/desktop/node_modules/vite/bin/vite.js'

$env:LOCALBRIDGE_PROCESS_HELPER_BINARY = $helperPath
$env:LOCALBRIDGE_PROCESS_NODE_BINARY = $nodePath
$env:LOCALBRIDGE_VITE_CLI = $vitePath

$verifiers = @(
    @{
        Name = 'process'
        Config = '../../scripts/vite.electron-process-test.config.ts'
        Output = 'dist/electron-process-test'
        Timeout = 60000
    },
    @{
        Name = 'multiservice'
        Config = '../../scripts/vite.electron-multiservice-test.config.ts'
        Output = 'dist/electron-multiservice-test'
        Timeout = 90000
    }
)

Push-Location $workspaceRoot
try {
    foreach ($verifier in $verifiers) {
        pnpm --filter '@localbridge/desktop' exec vite build --config $verifier.Config
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

        $outputRoot = Join-Path $workspaceRoot $verifier.Output
        $entryPath = Join-Path $outputRoot 'index.cjs'
        $stdoutPath = Join-Path $outputRoot 'verify.stdout.log'
        $stderrPath = Join-Path $outputRoot 'verify.stderr.log'
        foreach ($requiredPath in @($electronPath, $helperPath, $nodePath, $vitePath, $entryPath)) {
            if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
                throw "Electron development verifier dependency is missing: $requiredPath"
            }
        }

        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
        $process = Start-Process -FilePath $electronPath -ArgumentList @($entryPath) `
            -WorkingDirectory $workspaceRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath -PassThru
        $nativeHandle = $process.Handle
        try {
            if (-not $process.WaitForExit($verifier.Timeout)) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                throw "Electron $($verifier.Name) verification exceeded its timeout."
            }
            $process.WaitForExit()
            $process.Refresh()
            if ($process.ExitCode -ne 0) {
                $diagnostic = if (Test-Path -LiteralPath $stderrPath) {
                    Get-Content -LiteralPath $stderrPath -Raw
                } else {
                    '<stderr unavailable>'
                }
                throw "Electron $($verifier.Name) verification failed with exit code $($process.ExitCode).`n$diagnostic"
            }
        } finally {
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
            }
        }
        Get-Content -LiteralPath $stdoutPath
    }
} finally {
    Pop-Location
}
