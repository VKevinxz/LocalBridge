$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$workspaceRoot = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $workspaceRoot 'apps/desktop/node_modules/electron/dist/electron.exe'
$entryPath = Join-Path $PSScriptRoot 'verify-electron-viewer-scale-spike.cjs'
$stdoutPath = Join-Path $workspaceRoot 'dist/viewer-scale-spike.stdout.log'
$stderrPath = Join-Path $workspaceRoot 'dist/viewer-scale-spike.stderr.log'

$process = Start-Process -FilePath $electronPath -ArgumentList @($entryPath) -WorkingDirectory $workspaceRoot -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
$nativeHandle = $process.Handle
if (-not $process.WaitForExit(30000)) {
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  throw 'Electron viewer scale spike exceeded 30 seconds.'
}
$process.WaitForExit()
$process.Refresh()
if ($process.ExitCode -ne 0) {
  $diagnostic = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '<stderr unavailable>' }
  throw "Electron viewer scale spike failed with exit code $($process.ExitCode).`n$diagnostic"
}
Get-Content -LiteralPath (Join-Path $workspaceRoot 'dist/viewer-scale-spike.json') -Raw
