param(
  [switch]$DirectoryOnly,
  [ValidateSet("never", "always")]
  [string]$Publish = "never"
)

$ErrorActionPreference = "Stop"
$project = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$releaseRoot = [IO.Path]::GetFullPath((Join-Path $project "release"))
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $project ".build-cache"))
$cache = [IO.Path]::GetFullPath((Join-Path $cacheRoot "electron-dist"))
$temporary = [IO.Path]::GetFullPath((Join-Path $releaseRoot "win-unpacked.tmp"))

if (-not $cache.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a cache path outside the build-cache directory: $cache"
}
if (-not $temporary.StartsWith($releaseRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to use a packaging path outside the release directory: $temporary"
}

Set-Location $project

function Invoke-PhoenixBuilder([bool]$UseCache) {
  $builderArgs = @("electron-builder")
  if ($DirectoryOnly) { $builderArgs += @("--dir", "--win", "--x64") }
  else { $builderArgs += @("--win", "nsis", "--x64") }
  $builderArgs += @("--publish", $Publish)
  if ($UseCache) { $builderArgs += "--config.electronDist=$cache" }
  & npx.cmd @builderArgs
  $script:PhoenixBuilderExitCode = $LASTEXITCODE
}

$hasCache = Test-Path -LiteralPath (Join-Path $cache "electron.exe")
Invoke-PhoenixBuilder $hasCache
$exitCode = $script:PhoenixBuilderExitCode
if ($exitCode -eq 0) { exit 0 }

# Some Windows security scanners hold the freshly extracted Electron directory
# just long enough for Node's immediate atomic rename to fail with EPERM. The
# staging path contains only the downloaded Electron runtime at this point.
# Preserve it as a verified custom distribution and let electron-builder copy
# from that supported input on the retry. Never overwrite an existing cache.
if (-not $hasCache -and (Test-Path -LiteralPath (Join-Path $temporary "electron.exe")) -and -not (Test-Path -LiteralPath $cache)) {
  Move-Item -LiteralPath $temporary -Destination $cache
  Write-Host "Retrying with the verified unpacked Electron runtime cache."
  Invoke-PhoenixBuilder $true
  $exitCode = $script:PhoenixBuilderExitCode
}

exit $exitCode
