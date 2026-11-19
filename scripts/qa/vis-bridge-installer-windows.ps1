# Purpose: install, exercise, reinstall, and uninstall the native vis_bridge
# Windows installer while checking daemon lifecycle and PATH registration.
#
# Usage (from the repository root on a Windows runner):
#   ./scripts/qa/vis-bridge-installer-windows.ps1

$ErrorActionPreference = 'Stop'

# Native exit codes must be checked ONE BY ONE. PowerShell's default native-error setting does
# not make a non-zero native exit throw, and the GitHub pwsh wrapper propagates only the FINAL
# exit code — so a failing assert-pty (exit 1) followed by a successful lifecycle spawn and a
# successful uninstall made the whole step report green. Every native call below goes through
# Invoke-Native, which throws on a non-zero exit and names the command that failed.
function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [string[]]$Arguments = @(),
    [string]$Label
  )
  $what = if ($Label) { $Label } else { ($Command, ($Arguments -join ' ')).Trim() }
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "native command failed ($what): exit code $LASTEXITCODE"
  }
}

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
  Invoke-Native -Command 'vis_bridge' -Arguments @('--help') -Label 'vis_bridge --help'
  $env:VIS_BRIDGE_STATE_DIR = $stateDirectory
  $daemonStarted = $true
  Invoke-Native -Command 'vis_bridge' -Arguments @('start', '--port', '23199') -Label 'vis_bridge start --port 23199'
  Invoke-Native -Command 'node' -Arguments @('scripts/qa/vis-bridge-installer-daemon-qa.mjs', 'assert-pty', $env:VIS_BRIDGE_STATE_DIR, '23199', 'unused') -Label 'installer assert-pty'
  $lifecycleEvidence = Join-Path $env:RUNNER_TEMP 'bridge-lifecycle.json'
  Invoke-Native -Command 'node' -Arguments @('scripts/qa/vis-bridge-installer-daemon-qa.mjs', 'spawn', $env:VIS_BRIDGE_STATE_DIR, '23199', $lifecycleEvidence) -Label 'installer spawn (first install)'
  $customStateDirectory = $env:VIS_BRIDGE_STATE_DIR
  Remove-Item Env:VIS_BRIDGE_STATE_DIR
  $secondInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
  if ($secondInstall.ExitCode -ne 0) { throw "Daemon reinstall exited with $($secondInstall.ExitCode)" }
  Invoke-Native -Command 'node' -Arguments @('scripts/qa/vis-bridge-installer-daemon-qa.mjs', 'assert-stopped', $customStateDirectory, '23199', $lifecycleEvidence) -Label 'installer assert-stopped (after reinstall)'
  $daemonStarted = $false
  $env:VIS_BRIDGE_STATE_DIR = $customStateDirectory
  $daemonStarted = $true
  Invoke-Native -Command 'vis_bridge' -Arguments @('start', '--port', '23199') -Label 'vis_bridge start --port 23199'
  $uninstallEvidence = Join-Path $env:RUNNER_TEMP 'bridge-uninstall-lifecycle.json'
  Invoke-Native -Command 'node' -Arguments @('scripts/qa/vis-bridge-installer-daemon-qa.mjs', 'spawn', $env:VIS_BRIDGE_STATE_DIR, '23199', $uninstallEvidence) -Label 'installer spawn (before uninstall)'
  $uninstaller = Join-Path $installDirectory 'Uninstall.exe'
  Remove-Item Env:VIS_BRIDGE_STATE_DIR
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
  Invoke-Native -Command 'node' -Arguments @('scripts/qa/vis-bridge-installer-daemon-qa.mjs', 'assert-stopped', $customStateDirectory, '23199', $uninstallEvidence) -Label 'installer assert-stopped (after uninstall)'
  $daemonStarted = $false
} finally {
  Remove-Item Env:VIS_BRIDGE_STATE_DIR -ErrorAction SilentlyContinue

  if ($daemonStarted) {
    try {
      $env:VIS_BRIDGE_STATE_DIR = $stateDirectory
      Invoke-Native -Command 'vis_bridge' -Arguments @('stop') -Label 'vis_bridge stop'
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
