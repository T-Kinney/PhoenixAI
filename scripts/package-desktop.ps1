$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $PSScriptRoot
Set-Location $project

# Keep folder packaging on the same dependency collection, asar layout, and
# verification path as the NSIS release. The previous hand-copied folder
# included only dotenv even though the host imports Express, CORS, the updater,
# and logging packages, so it could build successfully and fail on launch.
& npm.cmd run icon
if ($LASTEXITCODE -ne 0) { throw "Icon generation failed." }
& npm.cmd run verify
if ($LASTEXITCODE -ne 0) { throw "Verification failed." }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows.ps1 -DirectoryOnly -Publish never
if ($LASTEXITCODE -ne 0) { throw "Desktop folder packaging failed." }
& node scripts/verify-packaged.mjs
if ($LASTEXITCODE -ne 0) { throw "Packaged application verification failed." }

$appPath = Join-Path $project "release\win-unpacked\PhoenixAI.exe"
Write-Host "Packaged app: $appPath"
