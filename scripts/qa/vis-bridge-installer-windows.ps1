# Purpose: install, exercise, reinstall, and uninstall the native vis_bridge
# Windows installer while checking daemon lifecycle and PATH registration.
#
# Usage (from the repository root on a Windows runner):
#   ./scripts/qa/vis-bridge-installer-windows.ps1

$ErrorActionPreference = 'Stop'

$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs/vis_bridge'
$originalUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$originalProcessPath = $env:Path
$stateDirectory = Join-Path $env:RUNNER_TEMP 'vis-bridge-state'
$installationAttempted = $false
$daemonStarted = $false

$installerCandidates = @(Get-ChildItem 'dist-bridge/installers/*.exe' -File)
if ($installerCandidates.Count -eq 0) {
  throw 'No Windows vis_bridge installer found under dist-bridge/installers'
}
$osArchitecture = $env:PROCESSOR_ARCHITEW6432
if ([string]::IsNullOrWhiteSpace($osArchitecture)) { $osArchitecture = $env:PROCESSOR_ARCHITECTURE }
$expectedArchitecture = switch ($osArchitecture.ToUpperInvariant()) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported Windows OS architecture '$osArchitecture'; expected AMD64 or ARM64" }
}
$matchingInstallers = @(
  $installerCandidates |
    Where-Object { $_.Name -match "-$expectedArchitecture-Windows\.exe$" }
)
if ($matchingInstallers.Count -eq 0) {
  $availableInstallers = $installerCandidates.Name -join ', '
  throw "No Windows vis_bridge installer matches OS architecture '$expectedArchitecture'. Available installers: $availableInstallers"
}
$installer = $matchingInstallers |
  Sort-Object @{ Expression = 'LastWriteTimeUtc'; Descending = $true }, @{ Expression = 'Name'; Descending = $false } |
  Select-Object -First 1

try {
  $installationAttempted = $true
  $firstInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($firstInstall.ExitCode -ne 0) { throw "Installer exited with $($firstInstall.ExitCode)" }
  $secondInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($secondInstall.ExitCode -ne 0) { throw "Reinstall exited with $($secondInstall.ExitCode)" }
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $pathMatches = @($userPath -split ';' | Where-Object { $_ -eq $installDirectory })
  if ($pathMatches.Count -ne 1) { throw "Installer added PATH entry $($pathMatches.Count) times" }
  $env:Path = "$env:Path;$userPath"
  vis_bridge --help
  $env:VIS_BRIDGE_STATE_DIR = $stateDirectory
  $daemonStarted = $true
  vis_bridge start --port 23199
  node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-pty $env:VIS_BRIDGE_STATE_DIR 23199 unused
  $lifecycleEvidence = Join-Path $env:RUNNER_TEMP 'bridge-lifecycle.json'
  node scripts/qa/vis-bridge-installer-daemon-qa.mjs spawn $env:VIS_BRIDGE_STATE_DIR 23199 $lifecycleEvidence
  $customStateDirectory = $env:VIS_BRIDGE_STATE_DIR
  Remove-Item Env:VIS_BRIDGE_STATE_DIR
  $secondInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($secondInstall.ExitCode -ne 0) { throw "Daemon reinstall exited with $($secondInstall.ExitCode)" }
  node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-stopped $customStateDirectory 23199 $lifecycleEvidence
  $daemonStarted = $false
  $env:VIS_BRIDGE_STATE_DIR = $customStateDirectory
  $daemonStarted = $true
  vis_bridge start --port 23199
  $uninstallEvidence = Join-Path $env:RUNNER_TEMP 'bridge-uninstall-lifecycle.json'
  node scripts/qa/vis-bridge-installer-daemon-qa.mjs spawn $env:VIS_BRIDGE_STATE_DIR 23199 $uninstallEvidence
  $uninstaller = Join-Path $installDirectory 'Uninstall.exe'
  Remove-Item Env:VIS_BRIDGE_STATE_DIR
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
  node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-stopped $customStateDirectory 23199 $uninstallEvidence
  $daemonStarted = $false
} finally {
  Remove-Item Env:VIS_BRIDGE_STATE_DIR -ErrorAction SilentlyContinue

  if ($daemonStarted) {
    try {
      $env:VIS_BRIDGE_STATE_DIR = $stateDirectory
      vis_bridge stop
    } catch {
      # Continue cleanup so a failed stop cannot prevent uninstall and PATH restoration.
    } finally {
      Remove-Item Env:VIS_BRIDGE_STATE_DIR -ErrorAction SilentlyContinue
    }
  }

  if ($installationAttempted) {
    $cleanupUninstaller = Get-ChildItem $installDirectory -Filter 'Uninstall.exe' -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($cleanupUninstaller) {
      try {
        Start-Process -FilePath $cleanupUninstaller.FullName -ArgumentList '/S' -Wait -ErrorAction Stop | Out-Null
      } catch {
        # Preserve the original test failure while still restoring the environment below.
      }
    }
  }

  [Environment]::SetEnvironmentVariable('Path', $originalUserPath, 'User')
  $env:Path = $originalProcessPath
  Remove-Item Env:VIS_BRIDGE_STATE_DIR -ErrorAction SilentlyContinue
}
