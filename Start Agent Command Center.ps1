$ErrorActionPreference = "Stop"

$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $appDir

if (-not (Test-Path (Join-Path $appDir "node_modules"))) {
  Write-Host "Installing dependencies..."
  & npm.cmd install
}

$server = Get-NetTCPConnection -LocalPort 5173 -ErrorAction SilentlyContinue
if (-not $server) {
  Write-Host "Starting Agent Command Center..."
  Start-Process -FilePath "npm.cmd" -ArgumentList @("run", "dev") -WorkingDirectory $appDir -WindowStyle Normal
  Start-Sleep -Seconds 3
}

Start-Process "http://127.0.0.1:5173/"
