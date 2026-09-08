// @vitest-environment node
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { text } from 'node:stream/consumers';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPosixUpdateHelper,
  createWindowsUpdateBootstrap,
  createWindowsUpdateHelper,
  handoffPosixInstaller,
  handoffWindowsInstaller,
  waitForAck,
} from '../bridge/updateHandoff.js';

const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

function esmImportSpecifier(filePath: string): string {
  return pathToFileURL(filePath).href;
}

afterEach(async () => {
  await Promise.all([
    ...temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    ...temporaryFiles.splice(0).map((file) => rm(file, { force: true })),
  ]);
});

describe('bridge updater installer handoff', () => {
  it('refuses POSIX installation when execve is unavailable instead of spawning a child', async () => {
    await expect(handoffPosixInstaller({
      assetPath: '/private/staging/update.deb', platform: 'linux', linuxFormat: 'deb',
      nonInteractiveYes: false, uid: 1000, execve: null,
      writeHelper: vi.fn(async () => '/private/staging/install.sh'),
    })).rejects.toThrow('process.execve is unavailable');
  });

  it('exec-replaces the updater on POSIX and never falls back to a killable child process', async () => {
    const execve = vi.fn();
    const helperPath = '/private/staging/install.sh';
    await handoffPosixInstaller({
      assetPath: '/private/staging/update.deb', platform: 'linux', linuxFormat: 'deb',
      nonInteractiveYes: true, uid: 1000, execve,
      writeHelper: vi.fn(async () => helperPath),
    });

    expect(execve).toHaveBeenCalledWith('/bin/sh', [
      '/bin/sh', helperPath, '/private/staging/update.deb', 'sudo-noninteractive',
    ], expect.any(Object));
  });

  it('uses only fixed absolute installer commands and cleans staging after the POSIX result', () => {
    const deb = createPosixUpdateHelper('linux', 'deb');
    const rpm = createPosixUpdateHelper('linux', 'rpm');
    const mac = createPosixUpdateHelper('darwin', null);
    expect(deb).toContain('/usr/bin/dpkg -i -- "$installer"');
    expect(rpm).toContain('/usr/bin/rpm -U -- "$installer"');
    expect(mac).toContain('/usr/sbin/installer -pkg "$installer" -target /');
    expect(deb).toContain('/bin/rm -rf -- "$staging_dir"');
    expect(deb).not.toContain('eval');
  });

  it('makes the Windows helper open and await the parent process handle before NSIS /S', () => {
    const helper = createWindowsUpdateHelper();
    expect(helper).toContain('OpenProcess');
    expect(helper).toContain('WaitForSingleObject');
    expect(helper).toContain('WaitForSingleObject($parentHandle, [uint32]::MaxValue)');
    expect(helper).toContain("[IO.File]::WriteAllText($AckPath, ('ready' + [Environment]::NewLine + $resultLogPath))");
    expect(helper.indexOf('WaitForSingleObject')).toBeLessThan(helper.indexOf("ArgumentList '/S'"));
    expect(helper).toContain("[IO.File]::WriteAllText($resultLogPath, ('status=success'");
    expect(helper).toContain("[IO.File]::WriteAllText($resultLogPath, ('status=failure'");
    expect(helper.indexOf('$resultLogPath')).toBeLessThan(helper.indexOf('Remove-Item -LiteralPath $StagingDirectory'));
  });

  it('encodes a hidden PowerShell bootstrap that waits for the real helper process', () => {
    const command = createWindowsUpdateBootstrap({
      powershellPath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      helperPath: String.raw`C:\private & staging\install helper.ps1`,
      parentPid: 42,
      ackPath: String.raw`C:\private & staging\ready`,
      installerPath: String.raw`C:\private & staging\update package.exe`,
      stagingDirectory: String.raw`C:\private & staging`,
    });
    const bootstrap = Buffer.from(command, 'base64').toString('utf16le');

    expect(bootstrap).toContain('Start-Process');
    expect(bootstrap).toContain('-WindowStyle Hidden');
    expect(bootstrap).toContain('$helper.WaitForExit()');
    expect(bootstrap).not.toContain(String.raw`C:\private & staging`);
  });

  it('waits for the Windows handle-ready acknowledgement before accepting handoff', async () => {
    const child = new ChildProcess();
    const unref = vi.spyOn(child, 'unref');
    const resultLogPath = String.raw`C:\Users\me\AppData\Local\Temp\vis_bridge-updates\installer-42.log`;
    const waitForAck = vi.fn(async () => resultLogPath);
    const spawnProcess = vi.fn(() => child);
    const accepted = vi.fn();

    await handoffWindowsInstaller({
      assetPath: String.raw`C:\private\update.exe`, parentPid: 42,
      powershellPath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      spawnProcess, waitForAck, onAccepted: accepted,
      writeHelper: vi.fn(async () => ({
        helperPath: String.raw`C:\private\install.ps1`, ackPath: String.raw`C:\private\ready`,
      })),
    });

    expect(waitForAck).toHaveBeenCalledWith(String.raw`C:\private\ready`, child);
    expect(spawnProcess).toHaveBeenCalledWith(expect.stringContaining('System32'), expect.arrayContaining([
      '-EncodedCommand', expect.any(String),
    ]), expect.objectContaining({ detached: false, stdio: 'ignore', windowsHide: true }));
    expect(unref).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenCalledWith(resultLogPath);
  });

  it('converts Windows drive paths before embedding them in an ESM driver', async () => {
    const windowsModulePath = String.raw`D:\ci\bridge\updateHandoff.js`;
    const driverProcess = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      `import(${JSON.stringify(windowsModulePath)})`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const [[driverExit], driverStderr] = await Promise.all([
      once(driverProcess, 'exit'),
      text(driverProcess.stderr),
    ]);

    expect(driverExit, driverStderr).not.toBe(0);
    expect(driverStderr).toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME');
    expect(new URL(esmImportSpecifier(windowsModulePath)).protocol).toBe('file:');
  });

  it('keeps a separate Node protocol driver alive until acknowledgement arrives', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-bridge-ack-driver-'));
    temporaryDirectories.push(directory);
    const ackPath = path.join(directory, 'ready');
    const startedPath = path.join(directory, 'started');
    const resultPath = path.join(directory, 'accepted');
    const moduleUrl = esmImportSpecifier(path.resolve(import.meta.dirname, '../bridge/updateHandoff.js'));
    const driver = `
      import { EventEmitter } from 'node:events';
      import { writeFile } from 'node:fs/promises';
      import { waitForAck } from ${JSON.stringify(moduleUrl)};
      await writeFile(${JSON.stringify(startedPath)}, 'started');
      const helper = new EventEmitter();
      helper.pid = undefined;
      helper.kill = () => false;
      helper.unref = () => undefined;
      waitForAck(${JSON.stringify(ackPath)}, helper, { timeoutMs: 1000, pollIntervalMs: 10 })
        .then(() => writeFile(${JSON.stringify(resultPath)}, 'accepted'));
    `;
    const driverProcess = spawn(process.execPath, ['--input-type=module', '--eval', driver], {
      stdio: 'ignore',
    });
    const exitPromise = once(driverProcess, 'exit');
    await vi.waitFor(() => expect(existsSync(startedPath)).toBe(true));

    const exitedBeforeAck = await Promise.race([
      exitPromise.then(() => true),
      delay(100, false),
    ]);
    if (!exitedBeforeAck) await writeFile(ackPath, String.raw`ready
C:\Users\me\AppData\Local\Temp\vis_bridge-updates\installer.log`);
    if (!exitedBeforeAck) await exitPromise;

    expect(exitedBeforeAck).toBe(false);
    expect(await readFile(resultPath, 'utf8')).toBe('accepted');
  }, 7_000);

  it('rejects a readable malformed acknowledgement within the configured deadline', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis-bridge-malformed-ack-'));
    temporaryDirectories.push(directory);
    const ackPath = path.join(directory, 'ready');
    await writeFile(ackPath, 'not-ready');
    const helper = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1_000)'], {
      stdio: 'ignore',
    });
    const helperExit = once(helper, 'exit');
    const pending = waitForAck(ackPath, helper, { timeoutMs: 50, pollIntervalMs: 5 });

    const outcome = await Promise.race([
      pending.then(() => 'resolved', () => 'rejected'),
      delay(150, 'still-pending'),
    ]);
    if (outcome === 'still-pending') helper.kill();
    await helperExit;
    await pending.catch(() => undefined);

    expect(outcome).toBe('rejected');
    expect(helper.killed).toBe(true);
  });

  it('does not schedule another acknowledgement poll after the helper settles', async () => {
    const helper = new ChildProcess();
    let completeRead: ((value: string) => void) | undefined;
    const readAck = vi.fn(() => new Promise<string>((resolve) => { completeRead = resolve; }));
    const schedule = vi.fn(() => setTimeout(() => undefined, 1_000));
    const pending = waitForAck('/unused', helper, { readAck, schedule, timeoutMs: 1_000 });
    await vi.waitFor(() => expect(readAck).toHaveBeenCalledOnce());
    expect(schedule).toHaveBeenCalledOnce();

    helper.emit('exit', 1);
    await expect(pending).rejects.toThrow('before readiness');
    completeRead?.('not-ready');
    await Promise.resolve();

    expect(schedule).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'win32').each([
    ['success', 0],
    ['failure', 7],
  ])('writes a durable %s result through the real PowerShell helper protocol with shell-sensitive paths', async (expectedStatus, installerExit) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'vis bridge & powershell (helper)-'));
    temporaryDirectories.push(directory);
    const stagingDirectory = path.join(directory, 'staging');
    const acceptedPath = path.join(directory, 'accepted-path');
    const cleanupReleasePath = path.join(directory, 'release-cleanup');
    const helperPath = path.join(stagingDirectory, 'install.ps1');
    const ackPath = path.join(stagingDirectory, 'ready');
    const installerPath = path.join(stagingDirectory, 'fake installer & handoff.cmd');
    await mkdir(stagingDirectory);
    const cleanupReleasePathBase64 = Buffer.from(cleanupReleasePath).toString('base64');
    const helper = createWindowsUpdateHelper().replace(
      '  Remove-Item -LiteralPath $StagingDirectory -Recurse -Force -ErrorAction SilentlyContinue',
      `  $cleanupReleasePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${cleanupReleasePathBase64}'))
  while (-not (Test-Path -LiteralPath $cleanupReleasePath)) { Start-Sleep -Milliseconds 10 }
  Remove-Item -LiteralPath $StagingDirectory -Recurse -Force -ErrorAction SilentlyContinue`,
    );
    await writeFile(helperPath, helper);
    await writeFile(installerPath, `@exit /b ${installerExit}\r\n`);
    const moduleUrl = esmImportSpecifier(path.resolve(import.meta.dirname, '../bridge/updateHandoff.js'));
    const powershellPath = path.win32.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const driver = `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { handoffWindowsInstaller, waitForAck } from ${JSON.stringify(moduleUrl)};
      await handoffWindowsInstaller({
        assetPath: ${JSON.stringify(installerPath)}, parentPid: process.pid,
        powershellPath: ${JSON.stringify(powershellPath)},
        spawnProcess: spawn, waitForAck,
        writeHelper: async () => ({ helperPath: ${JSON.stringify(helperPath)}, ackPath: ${JSON.stringify(ackPath)} }),
        onAccepted: (resultLogPath) => writeFileSync(${JSON.stringify(acceptedPath)}, resultLogPath),
      });
    `;
    const driverProcess = spawn(process.execPath, ['--input-type=module', '--eval', driver], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const [[driverExit, driverSignal], driverStderr] = await Promise.all([
      once(driverProcess, 'exit'),
      text(driverProcess.stderr),
    ]);
    expect(driverExit, `driver exited with code ${driverExit}, signal ${driverSignal}; stderr:\n${driverStderr}`).toBe(0);
    const resultLogPath = await readFile(acceptedPath, 'utf8');
    temporaryFiles.push(resultLogPath);
    try {
      await vi.waitFor(async () => {
        expect(await readFile(resultLogPath, 'utf8')).toContain(`status=${expectedStatus}`);
        expect(existsSync(stagingDirectory)).toBe(true);
      }, { timeout: 10_000 });
    } finally {
      await writeFile(cleanupReleasePath, 'release');
    }
    await vi.waitFor(async () => {
      expect(await readFile(resultLogPath, 'utf8')).toContain(`status=${expectedStatus}`);
      expect(existsSync(stagingDirectory)).toBe(false);
    }, { timeout: 10_000 });
  }, 20_000);
});
