$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

& (Join-Path $PSScriptRoot 'prepare-tunnel-client.ps1')
& (Join-Path $PSScriptRoot 'prepare-node-runtime.ps1')
& (Join-Path $PSScriptRoot 'build-windows-process-host.ps1')
