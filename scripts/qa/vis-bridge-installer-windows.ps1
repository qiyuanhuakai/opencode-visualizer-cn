$ErrorActionPreference = 'Stop'

$installer = Get-ChildItem 'dist-bridge/installers/*.exe' | Select-Object -First 1
$firstInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($firstInstall.ExitCode -ne 0) { throw "Installer exited with $($firstInstall.ExitCode)" }
$secondInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($secondInstall.ExitCode -ne 0) { throw "Reinstall exited with $($secondInstall.ExitCode)" }
$installDirectory = Join-Path $env:LOCALAPPDATA 'Programs/vis_bridge'
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$pathMatches = @($userPath -split ';' | Where-Object { $_ -eq $installDirectory })
if ($pathMatches.Count -ne 1) { throw "Installer added PATH entry $($pathMatches.Count) times" }
$env:Path = "$env:Path;$userPath"
vis_bridge --help
$env:VIS_BRIDGE_STATE_DIR = Join-Path $env:RUNNER_TEMP 'vis-bridge-state'
vis_bridge start --port 23199
node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-pty $env:VIS_BRIDGE_STATE_DIR 23199 unused
$lifecycleEvidence = Join-Path $env:RUNNER_TEMP 'bridge-lifecycle.json'
node scripts/qa/vis-bridge-installer-daemon-qa.mjs spawn $env:VIS_BRIDGE_STATE_DIR 23199 $lifecycleEvidence
$customStateDirectory = $env:VIS_BRIDGE_STATE_DIR
Remove-Item Env:VIS_BRIDGE_STATE_DIR
$secondInstall = Start-Process -FilePath $installer.FullName -ArgumentList '/S' -Wait -PassThru
if ($secondInstall.ExitCode -ne 0) { throw "Daemon reinstall exited with $($secondInstall.ExitCode)" }
node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-stopped $customStateDirectory 23199 $lifecycleEvidence
$env:VIS_BRIDGE_STATE_DIR = $customStateDirectory
vis_bridge start --port 23199
$uninstallEvidence = Join-Path $env:RUNNER_TEMP 'bridge-uninstall-lifecycle.json'
node scripts/qa/vis-bridge-installer-daemon-qa.mjs spawn $env:VIS_BRIDGE_STATE_DIR 23199 $uninstallEvidence
$uninstaller = Join-Path $installDirectory 'Uninstall.exe'
Remove-Item Env:VIS_BRIDGE_STATE_DIR
$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited with $($uninstall.ExitCode)" }
node scripts/qa/vis-bridge-installer-daemon-qa.mjs assert-stopped $customStateDirectory 23199 $uninstallEvidence
