function encodePowerShellCommand(command) {
  return Buffer.from(command, 'utf16le').toString('base64');
}

function decodeUtf8Expression(value) {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`;
}

export function createWindowsUpdateBootstrap(options) {
  const helperCommand = String.raw`$ErrorActionPreference = 'Stop'
$helperPath = ${decodeUtf8Expression(options.helperPath)}
$ackPath = ${decodeUtf8Expression(options.ackPath)}
$installerPath = ${decodeUtf8Expression(options.installerPath)}
$stagingDirectory = ${decodeUtf8Expression(options.stagingDirectory)}
& $helperPath -ParentPid ${options.parentPid} -AckPath $ackPath -InstallerPath $installerPath -StagingDirectory $stagingDirectory
exit $LASTEXITCODE`;
  const bootstrap = String.raw`$ErrorActionPreference = 'Stop'
$powershellPath = ${decodeUtf8Expression(options.powershellPath)}
$helperCommand = '${encodePowerShellCommand(helperCommand)}'
$helper = Start-Process -FilePath $powershellPath -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $helperCommand) -WindowStyle Hidden -PassThru
$helper.WaitForExit()
exit $helper.ExitCode`;
  return encodePowerShellCommand(bootstrap);
}
