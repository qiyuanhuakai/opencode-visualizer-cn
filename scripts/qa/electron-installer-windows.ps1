# Electron installer QA for the Windows lanes (Scenario S5).
#
# Silent per-user NSIS install of the lane's arch-scoped installer, locate the
# installed executable, then launch it through scripts/qa/electron-smoke.mjs
# with an isolated --user-data-dir: the driver asserts app://index.html, the
# Chromium sandbox, storage/clipboard round-trips and a clean quit. The smoke
# receipt must report this lane's native arch, and afterwards no Vis process
# may remain.
#
# Failure hygiene (runs on BOTH success and failure paths): the installer wait
# is bounded (tree-killed on timeout), leftover Vis processes are swept by PID
# tree, the installed app is silently uninstalled, and the final Get-Process
# residue check ALWAYS runs.
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

$programsDir = Join-Path $env:LOCALAPPDATA 'Programs'
$installDir = Join-Path $programsDir 'Vis'
$smokeOut = Join-Path $env:RUNNER_TEMP "smoke-installer-$Arch"
$failures = @()
$installerProcess = $null

try {
  # Bounded installer wait: poll HasExited up to 600s; on timeout tree-kill
  # the installer so the lane cannot hang or leave a zombie setup process.
  $installArgs = @('/S', '/currentuser', "/D=$installDir")
  $installerProcess = Start-Process -FilePath $installer.FullName -ArgumentList $installArgs -PassThru
  $deadline = (Get-Date).AddSeconds(600)
  while (-not $installerProcess.HasExited -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    $installerProcess.Refresh()
  }
  if (-not $installerProcess.HasExited) {
    taskkill /PID $installerProcess.Id /T /F 2>$null | Out-Null
    throw "NSIS install did not finish within 600s (pid $($installerProcess.Id) tree-killed)"
  }
  if ($installerProcess.ExitCode -ne 0) { throw "NSIS install exited with $($installerProcess.ExitCode)" }

  # The ARM64 NSIS bootstrapper can return before its child process publishes
  # the final install directory. Discover the exact executable with a bounded
  # wait instead of assuming the requested /D path is already materialized.
  $installedExe = $null
  $discoveryDeadline = (Get-Date).AddSeconds(120)
  while (-not $installedExe -and (Get-Date) -lt $discoveryDeadline) {
    $installedExe = Get-ChildItem $programsDir -Filter 'Vis.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $installedExe) { Start-Sleep -Seconds 2 }
  }
  if (-not $installedExe) { throw "Installed Vis.exe not found under $programsDir within 120s" }
  $installDir = $installedExe.DirectoryName
  Write-Host "Installed Vis at $($installedExe.FullName)"

  $env:VIS_ELECTRON_EXECUTABLE = $installedExe.FullName
  $env:VIS_SMOKE_OUT_DIR = $smokeOut
  node scripts/qa/electron-smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "Installed-app smoke failed with exit $LASTEXITCODE" }

  $receipt = Get-Content (Join-Path $smokeOut 'receipt.json') -Raw | ConvertFrom-Json
  if ($receipt.platform.arch -ne $Arch) {
    throw "Smoke ran on $($receipt.platform.arch), expected $Arch"
  }
} catch {
  $failures += $_.Exception.Message
} finally {
  # Runs on BOTH success and failure paths.
  Remove-Item Env:VIS_ELECTRON_EXECUTABLE, Env:VIS_SMOKE_OUT_DIR -ErrorAction SilentlyContinue

  # Final residue check — ALWAYS runs: the smoke driver must have quit the app.
  $residue = Get-Process -Name 'Vis' -ErrorAction SilentlyContinue
  if ($residue) { $failures += "Vis still running after smoke quit: $($residue.Id -join ', ')" }

  # Process-tree cleanup: sweep whatever is left (by PID tree) so the
  # uninstaller can run and the lane leaves no stragglers.
  foreach ($p in $residue) { taskkill /PID $p.Id /T /F 2>$null | Out-Null }

  # Uninstall the installed app (both paths).
  $uninstaller = Get-ChildItem $installDir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($uninstaller) {
    try {
      $u = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -PassThru -ErrorAction Stop
      $uninstallDeadline = (Get-Date).AddSeconds(600)
      while (-not $u.HasExited -and (Get-Date) -lt $uninstallDeadline) {
        Start-Sleep -Seconds 2
        $u.Refresh()
      }
      if (-not $u.HasExited) {
        taskkill /PID $u.Id /T /F 2>$null | Out-Null
        $failures += "Uninstall did not finish within 600s (pid $($u.Id) tree-killed)"
      } elseif ($u.ExitCode -ne 0) {
        $failures += "Uninstall exited with $($u.ExitCode)"
      }
    } catch {
      $failures += "Uninstall failed: $($_.Exception.Message)"
    }
  }
}

if ($failures.Count -gt 0) { throw ($failures -join '; ') }
Write-Host "ELECTRON-INSTALLER-QA PASS (windows/$Arch)"
