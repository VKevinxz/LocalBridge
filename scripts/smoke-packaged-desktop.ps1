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
$workingDirectory = Split-Path -Parent $resolvedExecutable
$started = $false

try {
    $first = Start-Process `
        -FilePath $resolvedExecutable `
        -ArgumentList "--user-data-dir=$userDataPath", '--enable-logging=stderr' `
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

    $firstGroup = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
    $second = Start-Process `
        -FilePath $resolvedExecutable `
        -ArgumentList "--user-data-dir=$userDataPath" `
        -WorkingDirectory $workingDirectory `
        -PassThru
    Start-Sleep -Seconds 2

    $secondGroup = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $resolvedExecutable })
    $processIds = @($secondGroup.ProcessId)
    $rootProcesses = @($secondGroup | Where-Object { $_.ParentProcessId -notin $processIds })
    if (-not $second.HasExited -or $rootProcesses.Count -ne 1 -or $secondGroup.Count -ne $firstGroup.Count) {
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

    Write-Output "Packaged desktop smoke passed: window='$($windowProcess.MainWindowTitle)', single instance."
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
}
