# Electron installer QA for the Windows lanes (Scenario S5).
#
# Silent per-user NSIS install of the lane's arch-scoped installer, locate the
# installed executable, then launch it through scripts/qa/electron-smoke.mjs
# with an isolated --user-data-dir: the driver asserts app://index.html, the
# Chromium sandbox, storage/clipboard round-trips and a clean quit. The smoke
# receipt must report this lane's native arch, and afterwards no Vis process
# may remain.
#
# Usage (from the repo root on a Windows runner):
#   ./scripts/qa/electron-installer-windows.ps1 -Arch x64
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('x64', 'arm64')]
  [string]$Arch
)
$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem "dist-electron/Vis-*-$Arch-Windows.exe" | Select-Object -First 1
if (-not $installer) { throw "No NSIS installer for arch $Arch under dist-electron" }

$install = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS install exited with $($install.ExitCode)" }

$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Vis'
$installedExe = Get-ChildItem $installDir -Filter '*.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike 'Uninstall*' } |
  Select-Object -First 1
if (-not $installedExe) { throw "Installed executable not found under $installDir" }
Write-Host "Installed Vis at $($installedExe.FullName)"

$smokeOut = Join-Path $env:RUNNER_TEMP "smoke-installer-$Arch"
$env:VIS_ELECTRON_EXECUTABLE = $installedExe.FullName
$env:VIS_SMOKE_OUT_DIR = $smokeOut
node scripts/qa/electron-smoke.mjs
if ($LASTEXITCODE -ne 0) { throw "Installed-app smoke failed with exit $LASTEXITCODE" }
Remove-Item Env:VIS_ELECTRON_EXECUTABLE, Env:VIS_SMOKE_OUT_DIR -ErrorAction SilentlyContinue

$receipt = Get-Content (Join-Path $smokeOut 'receipt.json') -Raw | ConvertFrom-Json
if ($receipt.platform.arch -ne $Arch) {
  throw "Smoke ran on $($receipt.platform.arch), expected $Arch"
}

# The smoke driver quits the app; no child processes may remain.
$leftover = Get-Process -Name 'Vis' -ErrorAction SilentlyContinue
if ($leftover) { throw "Vis still running after smoke quit: $($leftover.Id -join ', ')" }

Write-Host "ELECTRON-INSTALLER-QA PASS (windows/$Arch)"
