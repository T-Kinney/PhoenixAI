$ErrorActionPreference = "Stop"

$project = Split-Path -Parent $PSScriptRoot
$outRoot = Join-Path $project "release"
$appOut = Join-Path $outRoot "Agent Command Center"
$electronDist = Join-Path $project "node_modules\electron\dist"

Set-Location $project
& npm.cmd run build

if (-not (Test-Path -LiteralPath $electronDist)) {
  throw "Electron runtime not found. Run npm.cmd install first."
}

$projectResolved = (Resolve-Path -LiteralPath $project).Path
if (Test-Path -LiteralPath $appOut) {
  $appOutResolved = (Resolve-Path -LiteralPath $appOut).Path
  if (-not $appOutResolved.StartsWith($projectResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean outside project: $appOutResolved"
  }
  Get-ChildItem -Force -LiteralPath $appOutResolved | Remove-Item -Recurse -Force
} elseif (Test-Path -LiteralPath $outRoot) {
  $outResolved = (Resolve-Path -LiteralPath $outRoot).Path
  if (-not $outResolved.StartsWith($projectResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use outside project: $outResolved"
  }
}

New-Item -ItemType Directory -Force -Path $appOut | Out-Null
Get-ChildItem -Force -LiteralPath $electronDist | ForEach-Object {
  Copy-Item -Recurse -Force -LiteralPath $_.FullName -Destination $appOut
}

Rename-Item -LiteralPath (Join-Path $appOut "electron.exe") -NewName "Agent Command Center.exe"

$appResources = Join-Path $appOut "resources\app"
New-Item -ItemType Directory -Force -Path $appResources | Out-Null
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "dist") -Destination $appResources
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "electron") -Destination $appResources
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "models") -Destination $appResources
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "scripts") -Destination $appResources
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "server") -Destination $appResources
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "resources") -Destination $appResources
Copy-Item -Force -LiteralPath (Join-Path $project "package.json") -Destination $appResources

New-Item -ItemType Directory -Force -Path (Join-Path $appResources "node_modules") | Out-Null
Copy-Item -Recurse -Force -LiteralPath (Join-Path $project "node_modules\dotenv") -Destination (Join-Path $appResources "node_modules\dotenv")

$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Agent Command Center.lnk"
$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $appOut "Agent Command Center.exe"
$shortcut.WorkingDirectory = $appOut
$shortcut.IconLocation = Join-Path $appResources "resources\icon.ico"
$shortcut.Description = "Agent Command Center desktop client"
$shortcut.Save()

Write-Host "Packaged app: $($shortcut.TargetPath)"
Write-Host "Desktop shortcut: $shortcutPath"
