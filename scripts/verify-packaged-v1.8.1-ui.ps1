[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [ValidateRange(5, 60)]
    [int]$TimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop).Path
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$verifier = Join-Path $PSScriptRoot 'verify-packaged-v1.8.1-ui.mjs'
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('localbridge-v181-ui-' + [guid]::NewGuid().ToString('N'))
$userDataPath = Join-Path $testRoot 'electron-user-data'
$appDataPath = Join-Path $testRoot 'appdata'
$localAppDataPath = Join-Path $testRoot 'localappdata'
$userProfilePath = Join-Path $testRoot 'userprofile'
$configRoot = Join-Path $userProfilePath '.localbridge-mcp'
$devToolsPortPath = Join-Path $userDataPath 'DevToolsActivePort'
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$previousUserProfile = $env:USERPROFILE
$started = $null

try {
    New-Item -ItemType Directory -Path $appDataPath, $localAppDataPath, $userDataPath, $configRoot -Force | Out-Null
    $settings = @{
        onboardingStep = 4; onboardingCompleted = $true; minimizeToTray = $true
        largeArtifactPreference = @{ mode = 'standard'; reserve = @{ minimumFreeBytes = 1073741824; minimumFreePercent = 10 }; maxConcurrentJobs = 1 }
        gitApprovalMode = 'host'; activeConnectionProfileId = 'profile_default0'
        connectionProfiles = @(@{ id = 'profile_default0'; name = 'Personal'; tunnelId = '' })
        tunnelId = ''; tunnelBinaryPath = ''; tunnelProfile = 'local-stdio'; tunnelProfileDir = ''; serverCwd = ''
    }
    [IO.File]::WriteAllText((Join-Path $configRoot 'desktop-settings.json'), (($settings | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    $env:APPDATA = $appDataPath
    $env:LOCALAPPDATA = $localAppDataPath
    $env:USERPROFILE = $userProfilePath
    $started = Start-Process -FilePath $resolvedExecutable `
        -ArgumentList "--user-data-dir=$userDataPath", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0' `
        -WorkingDirectory (Split-Path -Parent $resolvedExecutable) -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath $devToolsPortPath -PathType Leaf) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if (-not (Test-Path -LiteralPath $devToolsPortPath -PathType Leaf)) { throw 'Packaged UI did not expose DevTools.' }
    $port = [int](Get-Content -LiteralPath $devToolsPortPath -TotalCount 1)
    & node $verifier $port
    if ($LASTEXITCODE -ne 0) { throw "La verificación UI empaquetada falló con exit $LASTEXITCODE" }
    $started.WaitForExit(5000) | Out-Null
    if (-not $started.HasExited) { throw 'Packaged UI did not exit through app:quit.' }
} finally {
    $env:APPDATA = $previousAppData
    $env:LOCALAPPDATA = $previousLocalAppData
    $env:USERPROFILE = $previousUserProfile
    if ($null -ne $started -and -not $started.HasExited) { Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $testRoot) {
        $resolvedRoot = (Resolve-Path -LiteralPath $testRoot).Path
        $resolvedTemp = (Resolve-Path -LiteralPath ([System.IO.Path]::GetTempPath())).Path
        if (-not $resolvedRoot.StartsWith($resolvedTemp, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Se rechazó limpiar fuera de TEMP: $resolvedRoot" }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
