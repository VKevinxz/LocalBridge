[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
    [string]$Repository,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9-]+$')]
    [string]$ReleaseReviewer,

    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$apiVersion = '2026-03-10'
$apiRoot = 'https://api.github.com'
$repoRoot = Split-Path -Parent $PSScriptRoot
$rulesetDirectory = Join-Path $repoRoot '.github/rulesets'
$rulesetPaths = @(
    Join-Path $rulesetDirectory 'protected-branches.json'
    Join-Path $rulesetDirectory 'release-tags.json'
)

function Read-Ruleset {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Missing ruleset definition: $Path"
    }

    $ruleset = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$ruleset.name) -or
        $ruleset.enforcement -ne 'active' -or
        $ruleset.target -notin @('branch', 'tag') -or
        @($ruleset.rules).Count -eq 0) {
        throw "Invalid fail-closed ruleset definition: $Path"
    }
    return $ruleset
}

$rulesets = @($rulesetPaths | ForEach-Object { Read-Ruleset -Path $_ })
$names = @($rulesets | ForEach-Object { $_.name })
if (@($names | Sort-Object -Unique).Count -ne $names.Count) {
    throw 'Ruleset names must be unique for idempotent updates.'
}

if (-not $Apply) {
    Write-Output "Validated GitHub publication plan for $Repository."
    Write-Output "Release reviewer: $ReleaseReviewer"
    $rulesets | ForEach-Object { Write-Output "Ruleset: $($_.name) [$($_.target)]" }
    Write-Output 'Apply was not requested; no network call or repository mutation occurred.'
    return
}

$token = [Environment]::GetEnvironmentVariable('LOCALBRIDGE_GITHUB_ADMIN_TOKEN', 'Process')
if ([string]::IsNullOrWhiteSpace($token)) {
    throw 'LOCALBRIDGE_GITHUB_ADMIN_TOKEN is required with -Apply.'
}

function Invoke-GitHubApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST', 'PUT', 'PATCH')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [object]$Body
    )

    $request = @{
        Uri         = "$apiRoot$Path"
        Method      = $Method
        Headers     = @{
            Accept                 = 'application/vnd.github+json'
            Authorization          = "Bearer $token"
            'X-GitHub-Api-Version' = $apiVersion
        }
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json'
        $request.Body = $Body | ConvertTo-Json -Depth 20 -Compress
    }
    Invoke-RestMethod @request
}

$encodedRepository = ($Repository -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }
$repositoryPath = $encodedRepository -join '/'
$encodedReviewer = [uri]::EscapeDataString($ReleaseReviewer)
$remoteRepository = Invoke-GitHubApi -Method GET -Path "/repos/$repositoryPath"
if ($remoteRepository.archived -or $remoteRepository.disabled) {
    throw 'The target repository is archived or disabled.'
}

$reviewer = Invoke-GitHubApi -Method GET -Path "/users/$encodedReviewer"
if ($null -eq $reviewer.id) {
    throw 'Could not resolve the release reviewer user ID.'
}

$existingRulesets = @(Invoke-GitHubApi -Method GET -Path "/repos/$repositoryPath/rulesets?per_page=100")
foreach ($ruleset in $rulesets) {
    $payload = $ruleset
    if ($payload.target -eq 'tag') {
        $payload | Add-Member -Force -NotePropertyName bypass_actors -NotePropertyValue @(
            [pscustomobject]@{
                actor_id   = [int64]$reviewer.id
                actor_type = 'User'
                bypass_mode = 'always'
            }
        )
    }

    $matches = @($existingRulesets | Where-Object { $_.name -eq $payload.name })
    if ($matches.Count -gt 1) {
        throw "Multiple remote rulesets have the name '$($payload.name)'."
    }
    if ($matches.Count -eq 1) {
        Invoke-GitHubApi -Method PUT -Path "/repos/$repositoryPath/rulesets/$($matches[0].id)" -Body $payload | Out-Null
    } else {
        Invoke-GitHubApi -Method POST -Path "/repos/$repositoryPath/rulesets" -Body $payload | Out-Null
    }
}

$environment = [pscustomobject]@{
    wait_timer = 0
    prevent_self_review = $false
    reviewers = @(
        [pscustomobject]@{
            type = 'User'
            id   = [int64]$reviewer.id
        }
    )
    deployment_branch_policy = $null
}
Invoke-GitHubApi -Method PUT -Path "/repos/$repositoryPath/environments/release" -Body $environment | Out-Null
Invoke-GitHubApi -Method PUT -Path "/repos/$repositoryPath/private-vulnerability-reporting" | Out-Null
Invoke-GitHubApi -Method PUT -Path "/repos/$repositoryPath/vulnerability-alerts" | Out-Null
Invoke-GitHubApi -Method PUT -Path "/repos/$repositoryPath/immutable-releases" | Out-Null

$verifiedRulesets = @(Invoke-GitHubApi -Method GET -Path "/repos/$repositoryPath/rulesets?per_page=100")
foreach ($name in $names) {
    $match = @($verifiedRulesets | Where-Object { $_.name -eq $name -and $_.enforcement -eq 'active' })
    if ($match.Count -ne 1) {
        throw "Remote ruleset verification failed: $name"
    }
}
$verifiedEnvironment = Invoke-GitHubApi -Method GET -Path "/repos/$repositoryPath/environments/release"
if (@($verifiedEnvironment.protection_rules | Where-Object { $_.type -eq 'required_reviewers' }).Count -ne 1) {
    throw 'The release environment does not require approval.'
}
$immutable = Invoke-GitHubApi -Method GET -Path "/repos/$repositoryPath/immutable-releases"
if (-not $immutable.enabled) {
    throw 'Immutable releases could not be verified.'
}

Write-Output "GitHub publication protections are active for $Repository."
