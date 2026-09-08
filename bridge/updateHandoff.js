import { spawn } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWindowsUpdateBootstrap } from './updateHandoffWindows.js';

export { createWindowsUpdateBootstrap } from './updateHandoffWindows.js';

export async function handoffBridgeInstaller(options) {
  if (options.platform === 'win32') return handoffWindowsInstaller(options);
  return handoffPosixInstaller(options);
}

export async function handoffPosixInstaller(options) {
  if (typeof options.execve !== 'function') {
    throw new Error('This vis_bridge runtime cannot safely hand off an installer because process.execve is unavailable.');
  }
  const helperPath = await options.writeHelper(
    options.assetPath,
    createPosixUpdateHelper(options.platform, options.linuxFormat),
  );
  const privilege = options.uid === 0
    ? 'root'
    : options.nonInteractiveYes ? 'sudo-noninteractive' : 'sudo';
  options.onAccepted?.();
  options.execve('/bin/sh', ['/bin/sh', helperPath, options.assetPath, privilege], { ...process.env });
}

export async function handoffWindowsInstaller(options) {
  const { helperPath, ackPath } = await options.writeHelper(
    options.assetPath,
    createWindowsUpdateHelper(),
  );
  const stagingDirectory = path.win32.dirname(options.assetPath);
  const bootstrapCommand = createWindowsUpdateBootstrap({
    powershellPath: options.powershellPath,
    helperPath,
    parentPid: options.parentPid,
    ackPath,
    installerPath: options.assetPath,
    stagingDirectory,
  });
  const child = options.spawnProcess(options.powershellPath, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    bootstrapCommand,
  ], {
    detached: false,
    env: { ...process.env },
    stdio: 'ignore',
    windowsHide: true,
  });
  if (typeof child.unref === 'function') child.unref();
  const resultLogPath = await options.waitForAck(ackPath, child);
  options.onAccepted?.(resultLogPath);
}

export function createPosixUpdateHelper(platform, linuxFormat) {
  const installerCommand = platform === 'darwin'
    ? '/usr/sbin/installer -pkg "$installer" -target /'
    : linuxFormat === 'rpm'
      ? '/usr/bin/rpm -U -- "$installer"'
      : '/usr/bin/dpkg -i -- "$installer"';
  return `#!/bin/sh
set -u
installer="$1"
privilege="$2"
staging_dir="\${installer%/*}"
cleanup() { /bin/rm -rf -- "$staging_dir"; }
trap cleanup EXIT
case "$privilege" in
  root) ${installerCommand} ;;
  sudo) /usr/bin/sudo ${installerCommand} ;;
  sudo-noninteractive) /usr/bin/sudo -n ${installerCommand} ;;
  *) /bin/printf '%s\n' 'Invalid updater privilege mode.' >&2; exit 2 ;;
esac
result=$?
if [ "$result" -eq 0 ]; then
  /bin/printf '%s\n' 'vis_bridge installer completed successfully.'
else
  /bin/printf 'vis_bridge installer failed with exit code %s.\n' "$result" >&2
fi
exit "$result"
`;
}

export function createWindowsUpdateHelper() {
  return String.raw`param(
  [Parameter(Mandatory = $true)][uint32]$ParentPid,
  [Parameter(Mandatory = $true)][string]$AckPath,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$StagingDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VisBridgeUpdateNative {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
}
'@
$parentHandle = [IntPtr]::Zero
$exitCode = 1
$resultDirectory = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) 'vis_bridge\updates'
$resultLogPath = Join-Path $resultDirectory ("installer-{0}-{1}.log" -f $ParentPid, [Guid]::NewGuid())
try {
  [IO.Directory]::CreateDirectory($resultDirectory) | Out-Null
  $parentHandle = [VisBridgeUpdateNative]::OpenProcess(0x00100000, $false, $ParentPid)
  if ($parentHandle -eq [IntPtr]::Zero) { throw 'Unable to acquire the vis_bridge parent process handle.' }
  [IO.File]::WriteAllText($AckPath, ('ready' + [Environment]::NewLine + $resultLogPath))
  $waitResult = [VisBridgeUpdateNative]::WaitForSingleObject($parentHandle, [uint32]::MaxValue)
  if ($waitResult -ne 0) { throw "Waiting for vis_bridge exit failed: $waitResult" }
  $process = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "vis_bridge installer failed with exit code $($process.ExitCode)." }
  [IO.File]::WriteAllText($resultLogPath, ('status=success' + [Environment]::NewLine + 'exit_code=0'))
  $exitCode = 0
} catch {
  $message = $_.Exception.Message
  [IO.File]::WriteAllText($resultLogPath, ('status=failure' + [Environment]::NewLine + "error=$message"))
} finally {
  if ($parentHandle -ne [IntPtr]::Zero) { [VisBridgeUpdateNative]::CloseHandle($parentHandle) | Out-Null }
  Remove-Item -LiteralPath $StagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
exit $exitCode
`;
}

export function createInstallerHandoff(options = {}) {
  const platform = options.platform ?? process.platform;
  const powershellPath = platform === 'win32'
    ? String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
    : null;
  return (request) => handoffBridgeInstaller({
    ...request,
    platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    parentPid: process.pid,
    powershellPath,
    execve: typeof process.execve === 'function' ? (...args) => process.execve(...args) : null,
    spawnProcess: spawn,
    waitForAck,
    writeHelper: platform === 'win32' ? writeWindowsHelper : writePosixHelper,
  });
}

async function writePosixHelper(assetPath, contents) {
  const helperPath = path.join(path.dirname(assetPath), 'install-vis-bridge.sh');
  await writeFile(helperPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o700 });
  await chmod(helperPath, 0o700);
  return helperPath;
}

async function writeWindowsHelper(assetPath, contents) {
  const directory = path.win32.dirname(assetPath);
  const helperPath = path.win32.join(directory, 'install-vis-bridge.ps1');
  const ackPath = path.win32.join(directory, 'parent-handle-ready');
  await writeFile(helperPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { helperPath, ackPath };
}

export function waitForAck(ackPath, child, options = {}) {
  const readAck = options.readAck ?? readFile;
  const schedule = options.schedule ?? setTimeout;
  const clearSchedule = options.clearSchedule ?? clearTimeout;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollHandle;
    let timeoutHandle;
    const finish = (error, terminateHelper = true, resultLogPath) => {
      if (settled) return;
      settled = true;
      if (pollHandle) clearSchedule(pollHandle);
      if (timeoutHandle) clearSchedule(timeoutHandle);
      child.off?.('error', onError);
      child.off?.('exit', onExit);
      if (error) {
        if (terminateHelper && child.pid) {
          try {
            child.kill?.();
          } catch (terminationError) {
            reject(new AggregateError([error, terminationError], 'Windows update helper termination failed.'));
            return;
          }
        }
        reject(error);
      }
      else resolve(resultLogPath);
    };
    const onError = (error) => finish(error);
    const onExit = (code) => finish(
      new Error(`Windows update helper exited before readiness acknowledgement (${code ?? 'unknown'}).`),
      false,
    );
    const poll = async () => {
      try {
        const value = await readAck(ackPath, 'utf8');
        if (settled) return;
        const [status, resultLogPath] = value.split(/\r?\n/u, 2);
        if (status === 'ready' && resultLogPath && path.win32.isAbsolute(resultLogPath)) {
          return finish(undefined, false, resultLogPath);
        }
      } catch (error) {
        if (settled) return;
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') return finish(error);
      }
      if (!settled) pollHandle = schedule(() => { void poll(); }, pollIntervalMs);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    timeoutHandle = schedule(() => {
      finish(new Error('Windows update helper did not acknowledge its parent process handle.'));
    }, timeoutMs);
    void poll();
  });
}
