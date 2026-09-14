$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$insideWorktree = git rev-parse --is-inside-work-tree
if ($LASTEXITCODE -ne 0 -or $insideWorktree -ne 'true') {
  throw 'Run this script inside a Git worktree.'
}

$sensitivePathPattern = '(?i)(^|/)(\.env($|\.)|workspaces\.json$|desktop-settings\.json$|tunnel-key\.enc$|tunnel-keys/[^/]+\.enc$|[^/]+\.(pfx|p12|pem|key|exe|zip)$)'
$secretPattern = '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})'
$knownSyntheticFixtureBlobs = @{
  # Contiene deliberadamente un encabezado ficticio para probar la denylist.
  # Cada entrada se autoriza por blob exacto: se conservan las revisiones
  # históricas y la vigente para que añadir una nueva no invalide el escaneo
  # de commits anteriores.
  'tests/helpers/fixtures.ts' = @(
    '4e380c0f33e886aab6565340aa2714caebfe1cc7',
    '954e7af24d02cc8f37a884b0bca7e1642fede8ce',
    'f9e72c79bdcaa9a12f47e54971d4b06b62c49dc4',
    'd3bc4af0a94eade0e4478fcd3f15cf8670040d02'
  )
}
$findings = [Collections.Generic.List[string]]::new()
$commits = @(git rev-list --all)
if ($LASTEXITCODE -ne 0) {
  throw 'Could not enumerate Git history.'
}

foreach ($commit in $commits) {
  $short = $commit.Substring(0, 12)
  $paths = @(git ls-tree -r --name-only $commit)
  if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect paths in $short."
  }
  $sensitivePaths = @($paths | Where-Object { $_ -match $sensitivePathPattern })
  if ($sensitivePaths.Count -gt 0) {
    $findings.Add("$short contains sensitive artifact paths: $($sensitivePaths -join ', ')")
  }

  $rawMatches = @(git grep -I -l -E -e $secretPattern $commit -- 2>$null)
  if ($LASTEXITCODE -gt 1) {
    throw "Could not scan content in $short."
  }
  $matchedFiles = @(
    foreach ($match in $rawMatches) {
      $separator = $match.IndexOf(':')
      $filePath = if ($separator -ge 0) { $match.Substring($separator + 1) } else { $match }
      $allowedBlobs = $knownSyntheticFixtureBlobs[$filePath]
      if ($null -ne $allowedBlobs) {
        $actualBlob = git rev-parse "$($commit):$filePath"
        if ($LASTEXITCODE -ne 0) { throw "Could not verify fixture blob in $short." }
        if (@($allowedBlobs) -contains $actualBlob) { continue }
      }
      $filePath
    }
  )
  if ($matchedFiles.Count -gt 0) {
    $findings.Add("$short contains possible secret material in: $($matchedFiles -join ', ')")
  }
}

if ($findings.Count -gt 0) {
  $findings | ForEach-Object { Write-Error $_ }
  throw 'Public history audit failed. Findings list file names only; inspect locally.'
}

Write-Output "Public history audit passed across $($commits.Count) commit(s)."
