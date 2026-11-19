import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

const methods = ['start', 'stop', 'snapshot', 'snapshotToken', 'upload', 'mutate', 'pty', 'attach', 'read', 'replay', 'reconnect', 'staleChannel', 'state'];
export async function startElectron(context) {
  const displayCommand = ['Xvfb', '-displayfd', '3', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'];
  context.register({ kind: 'Electron-display-planned', command: displayCommand, teardown: 'SIGTERM owned Xvfb, actual exit, PID and X socket absence' });
  const display = spawn(displayCommand[0], displayCommand.slice(1), { stdio: ['ignore', 'ignore', 'pipe', 'pipe'] });
  const displayExited = once(display, 'exit');
  context.register({ kind: 'Electron-display-created', pid: display.pid });
  const displayLog = path.join(context.runDir, 'electron-display.log');
  let displaySocket;
  await writeFile(displayLog, `${JSON.stringify(displayCommand)}\n`);
  display.stderr.on('data', data => appendFileSync(displayLog, data));
  context.own('Electron-display', async () => {
    if (display.exitCode === null && display.signalCode === null) display.kill('SIGTERM');
    const [code, signal] = await displayExited;
    const receipt = { pid: display.pid, code, signal, absent: !alive(display.pid), socketAbsent: !displaySocket || !existsSync(displaySocket) };
    await writeFile(path.join(context.runDir, 'electron-display-exit.json'), JSON.stringify(receipt, null, 2));
    assert(receipt.absent); assert(receipt.socketAbsent); assert.equal(code, 0); return receipt;
  });
  const displayNumber = await Promise.race([once(display.stdio[3], 'data').then(([data]) => data.toString().trim()), displayExited.then(([code, signal]) => { throw new Error(`Xvfb exited before readiness: ${code}/${signal}`); })]);
  assert.match(displayNumber, /^\d+$/);
  displaySocket = `/tmp/.X11-unix/X${displayNumber}`;
  context.register({ kind: 'Electron-virtual-display', display: `:${displayNumber}`, socket: `/tmp/.X11-unix/X${displayNumber}`, classification: 'owned virtual X server; actual visible BrowserWindows' });
  const executable = createRequire(import.meta.url)('electron');
  const profile = path.join(context.privateRoot, 'electron-profile');
  const command = [executable, fileURLToPath(import.meta.url), '--task19-electron', profile];
  context.register({ kind: 'Electron-planned', command, profile, teardown: 'stop each renderer connection; close windows; app.quit; actual child exit and PID absence' });
  const env = { ...process.env, DISPLAY: `:${displayNumber}` }; delete env.ELECTRON_RUN_AS_NODE; delete env.WAYLAND_DISPLAY; delete env.ELECTRON_DISABLE_SANDBOX;
  const child = spawn(command[0], command.slice(1), { cwd: context.root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  context.register({ kind: 'Electron-created', pid: child.pid });
  const exited = once(child, 'exit');
  let serial = 0, closing = false;
  const requests = new Map();
  const log = path.join(context.runDir, 'electron.log');
  await writeFile(log, `Electron invocation: ${JSON.stringify(command)}\nDisplay: ${env.DISPLAY ?? ''}; Wayland: ${env.WAYLAND_DISPLAY ?? ''}\n`);
  child.stdout.on('data', chunk => appendFileSync(log, chunk));
  child.stderr.on('data', chunk => appendFileSync(log, chunk));
  child.on('message', message => {
    const waiting = requests.get(message.id);
    if (!waiting) return;
    requests.delete(message.id); clearTimeout(waiting.timer);
    if (message.ok) waiting.resolve(message.value);
    else waiting.reject(Object.assign(new Error(message.error.message), message.error));
  });
  child.once('exit', (code, signal) => { for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error(`Electron exited ${code}/${signal}`)); } requests.clear(); });
  function request(input) {
    return new Promise((resolve, reject) => {
      if (!child.connected || child.exitCode !== null || child.signalCode !== null) { reject(new Error(`Electron IPC unavailable: ${child.exitCode}/${child.signalCode}`)); return; }
      const id = ++serial;
      const timer = setTimeout(() => { requests.delete(id); reject(new Error('Electron renderer action deadline')); }, 15000);
      requests.set(id, { resolve, reject, timer });
      child.send({ id, ...input }, error => { if (error) { requests.delete(id); clearTimeout(timer); reject(error); } });
    });
  }
  const close = async () => {
    if (closing) return;
    closing = true;
    try { if (child.connected && child.exitCode === null && child.signalCode === null) await request({ action: 'close' }); }
    finally {
      const deadline = setTimeout(() => child.kill('SIGTERM'), 5000);
      const [code, signal] = await exited; clearTimeout(deadline);
      await writeFile(path.join(context.runDir, 'electron-exit.json'), JSON.stringify({ pid: child.pid, code, signal, absent: !alive(child.pid) }, null, 2));
      assert.equal(code, 0); assert.equal(signal, null); assert.equal(alive(child.pid), false);
    }
    return { pid: child.pid, code: child.exitCode, signal: child.signalCode, absent: !alive(child.pid) };
  };
  context.own('Electron-app', close);
  const windows = await request({ action: 'open', url: context.pageUrl });
  for (const window of windows) {
    context.register({ kind: 'Electron-renderer', pid: window.pid, windowId: window.id, webContentsId: window.webContentsId });
    window.processStatus = await readFile(`/proc/${window.pid}/status`, 'utf8');
  }
  return {
    windows,
    evaluate(window, method, argument) { assert(methods.includes(method)); return request({ action: 'evaluate', window, method, argument }); },
    screenshot(window, name) { return request({ action: 'screenshot', window, filename: path.join(context.runDir, name) }); },
    close,
  };
}

async function electronMain() {
  const { app, BrowserWindow } = await import('electron');
  app.enableSandbox();
  app.disableHardwareAcceleration();
  assert.equal(app.commandLine.hasSwitch('no-sandbox'), false);
  assert.equal(process.env.ELECTRON_DISABLE_SANDBOX, undefined);
  app.setPath('userData', process.argv[process.argv.indexOf('--task19-electron') + 1]);
  const windows = [];
  app.on('window-all-closed', () => app.quit());
  process.on('message', async message => {
    try {
      await app.whenReady();
      let value;
      switch (message.action) {
        case 'open': {
          for (let index = 0; index < 2; index++) {
            const window = new BrowserWindow({ width: 1100, height: 850, show: true, title: `Task19 runtime QA ${index + 1}`, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `task19-window-${index}` } });
            windows.push(window);
            await window.loadURL(message.url);
            await window.webContents.executeJavaScript('new Promise((resolve, reject) => { const deadline = Date.now() + 15000; const timer = setInterval(() => { if (window.task19) { clearInterval(timer); resolve(true); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error("QA module readiness deadline")); } }, 20); })');
          }
          value = await Promise.all(windows.map(async window => ({ id: window.id, webContentsId: window.webContents.id, pid: window.webContents.getOSProcessId(), visible: window.isVisible(), url: window.webContents.getURL(), sandbox: window.webContents.getLastWebPreferences().sandbox, contextIsolation: window.webContents.getLastWebPreferences().contextIsolation, nodeIntegration: window.webContents.getLastWebPreferences().nodeIntegration, hardwareAccelerationDisabled: !app.isHardwareAccelerationEnabled(), sandboxDisableSwitch: app.commandLine.hasSwitch('no-sandbox'), boundary: await window.webContents.executeJavaScript('({ nodeRequire: typeof require, nodeProcess: typeof process })') })));
          break;
        }
        case 'evaluate': {
          assert(methods.includes(message.method));
          const expression = `Promise.resolve(window.task19[${JSON.stringify(message.method)}](${JSON.stringify(message.argument)})).then(value => value === undefined ? null : JSON.parse(JSON.stringify(value)))`;
          value = await windows[message.window].webContents.executeJavaScript(expression);
          break;
        }
        case 'screenshot': {
          const image = await windows[message.window].webContents.capturePage();
          assert.equal(image.isEmpty(), false);
          await writeFile(message.filename, image.toPNG()); value = { path: message.filename, size: image.getSize() }; break;
        }
        case 'close':
          for (const window of windows) await window.webContents.executeJavaScript('window.task19.stop()');
          process.send({ id: message.id, ok: true, value: { windows: windows.map(window => window.id), stopped: true } });
          for (const window of windows) window.close();
          app.quit(); return;
        default: throw new Error('Unknown Electron QA action');
      }
      process.send({ id: message.id, ok: true, value });
    } catch (error) { process.send({ id: message.id, ok: false, error: { message: error.message, stack: error.stack, code: error.code } }); }
  });
}
if (process.versions.electron && process.argv.includes('--task19-electron')) void electronMain().catch(error => { console.error(error); process.exitCode = 1; });
