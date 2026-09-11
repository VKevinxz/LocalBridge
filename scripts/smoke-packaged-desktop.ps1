[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,

    [ValidateRange(5, 60)]
    [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath -ErrorAction Stop).Path
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf) -or
    [System.IO.Path]::GetExtension($resolvedExecutable) -ne '.exe') {
    throw 'Packaged desktop executable must be an existing .exe file.'
}

$preexisting = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
if ($preexisting.Count -ne 0) {
    throw "Refusing to reuse or stop $($preexisting.Count) preexisting packaged process(es)."
}

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('localbridge-window-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$stderrPath = Join-Path $testRoot 'stderr.log'
$stdoutPath = Join-Path $testRoot 'stdout.log'
$userDataPath = Join-Path $testRoot 'electron-user-data'
$appDataPath = Join-Path $testRoot 'appdata'
$localAppDataPath = Join-Path $testRoot 'localappdata'
$userProfilePath = Join-Path $testRoot 'userprofile'
$devToolsPortPath = Join-Path $userDataPath 'DevToolsActivePort'
$workingDirectory = Split-Path -Parent $resolvedExecutable
$started = $false
$previousAppData = $env:APPDATA
$previousLocalAppData = $env:LOCALAPPDATA
$previousUserProfile = $env:USERPROFILE

try {
    # requestSingleInstanceLock usa las rutas de Electron antes de que Chromium
    # procese --user-data-dir. Aislar APPDATA permite probar un candidato sin
    # interrumpir la versión estable que el propietario tenga abierta.
    # La configuración autorizada usa os.homedir(), que en Windows resuelve
    # USERPROFILE. Aislar solo APPDATA reutilizaba accidentalmente el perfil real
    # y no ejercitaba el primer arranque sin .localbridge-mcp.
    New-Item -ItemType Directory -Path $appDataPath, $localAppDataPath, $userProfilePath -Force | Out-Null
    $env:APPDATA = $appDataPath
    $env:LOCALAPPDATA = $localAppDataPath
    $env:USERPROFILE = $userProfilePath
    $first = Start-Process `
        -FilePath $resolvedExecutable `
        -ArgumentList "--user-data-dir=$userDataPath", '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--enable-logging=stderr' `
        -WorkingDirectory $workingDirectory `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
    $started = $true

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $windowProcess = $null
    do {
        Start-Sleep -Milliseconds 250
        $matching = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
        foreach ($candidate in $matching) {
            $native = Get-Process -Id $candidate.ProcessId -ErrorAction SilentlyContinue
            if ($null -ne $native -and $native.MainWindowHandle -ne 0) {
                $windowProcess = $native
                break
            }
        }
    } while ($null -eq $windowProcess -and (Get-Date) -lt $deadline)

    if ($null -eq $windowProcess) {
        throw "Packaged desktop did not create a visible window. Diagnostic logs: $testRoot"
    }
    if ($windowProcess.MainWindowTitle -notmatch '^LocalBridge MCP . Escritorio$') {
        throw "Packaged desktop opened an unexpected window '$($windowProcess.MainWindowTitle)'. Diagnostic logs: $testRoot"
    }

    while (-not (Test-Path -LiteralPath $devToolsPortPath -PathType Leaf) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
    }
    if (-not (Test-Path -LiteralPath $devToolsPortPath -PathType Leaf)) {
        throw "Packaged desktop did not expose its isolated renderer. Diagnostic logs: $testRoot"
    }
    $devToolsPort = [int](Get-Content -LiteralPath $devToolsPortPath -TotalCount 1)
    & node (Join-Path $PSScriptRoot 'verify-packaged-first-run.mjs') $devToolsPort
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged desktop first-run verification failed. Diagnostic logs: $testRoot"
    }

    $second = Start-Process `
        -FilePath $resolvedExecutable `
        -ArgumentList "--user-data-dir=$userDataPath" `
        -WorkingDirectory $workingDirectory `
        -PassThru
    if (-not $second.WaitForExit(10000)) {
        $liveGroup = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
        $liveIds = @($liveGroup.ProcessId)
        $liveRoots = @($liveGroup | Where-Object { $_.ParentProcessId -notin $liveIds })
        throw "A second launch did not yield to the existing desktop instance. secondPid=$($second.Id), processes=$($liveGroup.Count), roots=$($liveRoots.Count)."
    }

    $secondGroup = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
    $processIds = @($secondGroup.ProcessId)
    $rootProcesses = @($secondGroup | Where-Object { $_.ParentProcessId -notin $processIds })
    if ($rootProcesses.Count -ne 1) {
        throw 'A second launch created another desktop instance.'
    }

    $fatalLines = @()
    if (Test-Path -LiteralPath $stderrPath) {
        $fatalLines = @(
            Get-Content -LiteralPath $stderrPath |
                Where-Object {
                    $_ -match '(?i)UnhandledPromiseRejection|ReferenceError|Uncaught Exception|Uncaught TypeError|Unable to load preload script'
                }
        )
    }
    if ($fatalLines.Count -ne 0) {
        throw "Packaged desktop logged $($fatalLines.Count) fatal startup error(s). Diagnostic logs: $testRoot"
    }

    & node (Join-Path $PSScriptRoot 'verify-packaged-first-run.mjs') $devToolsPort --quit
    if ($LASTEXITCODE -ne 0) {
        throw "Packaged desktop quit IPC verification failed. Diagnostic logs: $testRoot"
    }
    $quitDeadline = (Get-Date).AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
    } while ($remaining.Count -ne 0 -and (Get-Date) -lt $quitDeadline)
    if ($remaining.Count -ne 0) {
        throw "Packaged desktop did not exit through app:quit. Diagnostic logs: $testRoot"
    }

    Write-Output "Packaged desktop smoke passed: window='$($windowProcess.MainWindowTitle)', single instance, app:quit."
} finally {
    if ($started) {
        $ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
        foreach ($owned in ($ownedProcesses | Sort-Object ProcessId -Descending)) {
            $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($owned.ProcessId)" -ErrorAction SilentlyContinue
            if ($null -ne $current -and $current.ExecutablePath -eq $resolvedExecutable) {
                Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    $env:APPDATA = $previousAppData
    $env:LOCALAPPDATA = $previousLocalAppData
    $env:USERPROFILE = $previousUserProfile
}
