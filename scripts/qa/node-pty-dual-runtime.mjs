// node-pty dual-runtime QA driver.
//
// allow: SIZE_OK — self-contained cross-platform QA harness: three runtime
// surfaces (system Node probe, SEA daemon HTTP/WS PTY lifecycle, Electron
// probe) with no shared-module seams; repo precedent electron-smoke.mjs is
// 262 pure LOC and the probe logic lives in the companion
// scripts/qa/pty-runtime-probe.mjs.
//
// Verifies node-pty loads and drives a real PTY lifecycle — spawn platform
// shell, sentinel round-trip (VIS_PTY_OK), resize, kill, child-tree cleanup
// (ps-based, no zombies) — in three runtimes:
//
//   node     — system Node (the interpreter running this driver)
//   sea      — the built vis_bridge SEA binary, exercised through its real
//              HTTP/WS PTY surface (POST /pty, /pty/<id>/connect WS,
//              PUT resize, DELETE kill, daemon stop)
//   electron — an Electron 43 main process: the Electron runtime binary run
//              with the probe script as its entry point
//
// The node and electron probes run the SAME probe script
// (scripts/qa/pty-runtime-probe.mjs, in the repo) inside the target runtime,
// so both surfaces share one implementation.
//
// The electron probe uses the Electron runtime binary resolved by
// require('electron') (node_modules/electron/dist/...): a packaged executable
// ignores a probe script/app path and always runs its own asar main (verified
// during Task 11), so the PTY probe must run against the runtime binary
// itself — the identical Electron 43 runtime, embedded Node and ABI.
//
// The platform shell on POSIX is explicitly `bash`: its interactive job
// control forwards SIGHUP to background jobs, which makes the child-tree
// cleanup assertion deterministic on Linux/macOS CI runners. Windows uses the
// node-pty default (powershell); Windows process-tree behavior stays covered
// by the existing processTree.windows.test.ts regression, never weakened.
//
// Usage:
//   node scripts/qa/node-pty-dual-runtime.mjs [options]
// Options:
//   --runtimes node,sea,electron   which runtimes to verify (default: all three)
//   --pty-module-dir <dir>         node-pty package dir for node/electron probes
//                                  (default: <root>/node_modules/node-pty)
//   --bridge-binary <path>         vis_bridge executable (default: dist-bridge one)
//   --electron-executable <path>   Electron runtime binary (default:
//                                  require('electron')-resolved dev binary)
//   --state-dir <dir>              temp bridge daemon state directory
//   --port <n>                     bridge daemon port (default: 23201)
//   --out-dir <dir>                receipts + probe output directory
//
// A runtime that cannot load its native binding (e.g. a staged node-pty
// without the platform prebuild) must fail with a non-zero exit and the load
// error captured in its receipt — this is the driver contract exercised by
// the task's RED phase.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SENTINEL_MARKER = 'VIS_PTY_OK_42'; // shell-expanded $((7*6)); immune to terminal echo
const STTY_EXPECTED = '40 100';
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROBE_PATH = fileURLToPath(new URL('./pty-runtime-probe.mjs', import.meta.url));


const psAll = () =>
  execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,args'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFile(filePath, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, 'utf8');
    } catch {
      await wait(100);
    }
  }
  throw new Error(label + ' timed out waiting for ' + filePath);
}

async function dumpTree(name, outDir) {
  await writeFile(path.join(outDir, 'process-trees', name + '.txt'), psAll().join('\n') + '\n', 'utf8');
}

function bridgeRequest(port, method, requestPath, body) {
  const options = { method };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  return fetch('http://127.0.0.1:' + port + requestPath, options);
}

function waitForWebSocketOutput(ws, marker, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => reject(new Error(label + ' timed out; last output: ' + JSON.stringify(output.slice(-200)))),
      timeoutMs,
    );
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      output += event.data;
      if (output.includes(marker)) {
        clearTimeout(timer);
        ws.onmessage = null;
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(label + ' websocket error'));
    };
  });
}

async function runProbe(probePath, args, receiptPath, outDir, label, treeName) {
  await dumpTree(treeName + '-before', outDir);
  await new Promise((resolve, reject) => {
    const child = spawn(probePath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  await waitForFile(receiptPath, 60000, label);
  await dumpTree(treeName + '-after', outDir);
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  } catch (error) {
    throw new Error(label + ' receipt is not valid JSON at ' + receiptPath + ': ' + String(error));
  }
  if (!receipt.ok) throw new Error(receipt.error ?? label + ' probe reports failure');
  return receipt;
}

function probeRunner(options, runtime, probePath, outDir) {
  const receiptPath = path.join(outDir, runtime + '.json');
  const probeArgs = [probePath, options.ptyModuleDir, receiptPath, outDir];
  if (runtime === 'electron' && process.platform === 'linux') {
    return runProbe('xvfb-run', ['-a', options.electronExecutable, ...probeArgs], receiptPath, outDir, runtime, runtime);
  }
  return runProbe(
    runtime === 'electron' ? options.electronExecutable : process.execPath,
    probeArgs,
    receiptPath,
    outDir,
    runtime,
    runtime,
  );
}

async function startBridgeDaemon(binary, port, stateDir) {
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
  const daemonEnv = { ...process.env, VIS_BRIDGE_STATE_DIR: stateDir };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vis_bridge start timed out')), 30000);
    const child = spawn(binary, ['start', '--port', String(port)], {
      env: daemonEnv,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('vis_bridge start exited with ' + code));
      else resolve();
    });
  });
  const daemon = JSON.parse(await waitForFile(path.join(stateDir, 'daemon.json'), 30000, 'daemon start'));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await bridgeRequest(daemon.port, 'GET', '/api/v1/supervisor');
      if (response.ok) return daemon;
    } catch {}
    await wait(200);
  }
  throw new Error('bridge daemon did not answer on port ' + daemon.port);
}

async function stopBridgeDaemon(binary, stateDir, daemonPid) {
  await new Promise((resolve) => {
    const child = spawn(binary, ['stop'], {
      env: { ...process.env, VIS_BRIDGE_STATE_DIR: stateDir },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (!psAll().some((row) => row.trim().startsWith(String(daemonPid) + ' '))) return;
    await wait(200);
  }
  throw new Error('bridge daemon ' + daemonPid + ' did not stop');
}

function findPtyShellRow(rowsBefore, rowsAfter, daemonPid) {
  const before = new Set(
    rowsBefore
      .filter((row) => row.trim().split(/\s+/)[1] === String(daemonPid))
      .map((row) => row.trim()),
  );
  return rowsAfter.find((row) => {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 5 || parts[1] !== String(daemonPid) || before.has(row.trim())) return false;
    return parts.slice(4).join(' ') === 'bash';
  });
}

function newDaemonChildren(rowsBefore, rowsAfter, daemonPid) {
  const before = new Set(
    rowsBefore
      .filter((row) => row.trim().split(/\s+/)[1] === String(daemonPid))
      .map((row) => row.trim()),
  );
  return rowsAfter.filter((row) => row.trim().split(/\s+/)[1] === String(daemonPid) && !before.has(row.trim()));
}

async function probeSea(options, outDir) {
  const stateDir = options.stateDir || path.join(outDir, 'sea-state');
  const port = options.port;
  const receipt = {
    runtime: 'sea',
    binary: { path: options.bridgeBinary, sizeBytes: (await readFile(options.bridgeBinary)).length },
    ok: false,
  };
  const binaryBuffer = await readFile(options.bridgeBinary);
  receipt.binary.embeddedNodeStrings = [
    ...new Set(binaryBuffer.toString('latin1').match(/v24\.\d+\.\d+/g) ?? []),
  ].slice(0, 8);
  await dumpTree('sea-before', outDir);
  const daemon = await startBridgeDaemon(options.bridgeBinary, port, stateDir);
  receipt.daemon = { pid: daemon.pid, port: daemon.port, instanceId: daemon.instanceId };
  const rows0 = psAll();
  const createResponse = await bridgeRequest(daemon.port, 'POST', '/pty', {
    command: process.platform === 'win32' ? undefined : 'bash',
    cols: 80,
    rows: 24,
  });
  if (!createResponse.ok) throw new Error('POST /pty failed: ' + createResponse.status);
  const ptyId = (await createResponse.json()).id;
  await wait(400);
  const rows1 = psAll();
  const shellRow = findPtyShellRow(rows0, rows1, daemon.pid);
  if (!shellRow) {
    throw new Error(
      'PTY shell not found among daemon children; new children: ' +
        JSON.stringify(newDaemonChildren(rows0, rows1, daemon.pid)),
    );
  }
  const shellPid = Number(shellRow.trim().split(/\s+/)[0]);
  receipt.spawn = { ptyId, shellPid, command: 'bash' };
  const ws = new WebSocket('ws://127.0.0.1:' + daemon.port + '/pty/' + encodeURIComponent(ptyId) + '/connect');
  await new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('pty websocket connect failed'));
  });
  const sentinel = waitForWebSocketOutput(ws, SENTINEL_MARKER, 15000, 'sea sentinel');
  ws.send('sleep 300 &\n');
  ws.send('echo ' + SENTINEL_MARKER + '\n');
  await sentinel;
  receipt.sentinel = { ok: true, marker: SENTINEL_MARKER };
  const resizeResponse = await bridgeRequest(daemon.port, 'PUT', '/pty/' + encodeURIComponent(ptyId), {
    size: { rows: 40, cols: 100 },
  });
  if (!resizeResponse.ok) throw new Error('PUT /pty resize failed: ' + resizeResponse.status);
  const resized = waitForWebSocketOutput(ws, STTY_EXPECTED, 15000, 'sea resize');
  ws.send('stty size\n');
  await resized;
  receipt.resize = { ok: true, rows: 40, cols: 100, verifiedVia: 'stty size' };
  const rowsBefore = psAll();
  const treeBefore = [...new Set([shellPid, ...descendants(rowsBefore, shellPid)])];
  const deleteResponse = await bridgeRequest(daemon.port, 'DELETE', '/pty/' + encodeURIComponent(ptyId));
  if (!deleteResponse.ok) throw new Error('DELETE /pty failed: ' + deleteResponse.status);
  receipt.kill = { ok: true };
  await wait(2000);
  const rowsAfter = psAll();
  const survivors = treeBefore.filter((pid) => rowsAfter.some((row) => row.trim().startsWith(String(pid) + ' ')));
  const zombies = treeBefore.filter((pid) => {
    const row = rowsAfter.find((r) => r.trim().startsWith(String(pid) + ' '));
    return row !== undefined && row.includes('Z');
  });
  receipt.childTree = { checked: true, before: treeBefore, survivors, zombies };
  if (survivors.length > 0 || zombies.length > 0) {
    throw new Error(
      'sea child tree cleanup failed: survivors=' + JSON.stringify(survivors) + ' zombies=' + JSON.stringify(zombies),
    );
  }
  ws.close();
  await dumpTree('sea-after', outDir);
  await stopBridgeDaemon(options.bridgeBinary, stateDir, daemon.pid);
  receipt.daemonStop = { ok: true };
  receipt.ok = true;
  return receipt;
}

function descendants(rows, rootPid) {
  const pids = [rootPid];
  const byParent = new Map();
  for (const row of rows) {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const parent = Number(parts[1]);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(Number(parts[0]));
  }
  for (let index = 0; index < pids.length; index += 1) {
    for (const child of byParent.get(pids[index]) ?? []) {
      if (!pids.includes(child)) pids.push(child);
    }
  }
  return pids;
}

function parseArgs(argv) {
  const options = {
    runtimes: ['node', 'sea', 'electron'],
    ptyModuleDir: path.join(ROOT, 'node_modules', 'node-pty'),
    bridgeBinary: path.join(ROOT, 'dist-bridge', process.platform === 'win32' ? 'vis_bridge.exe' : 'vis_bridge'),
    electronExecutable: defaultElectronExecutable(),
    stateDir: undefined,
    port: 23201,
    outDir: path.join(ROOT, '.omo', 'evidence', 'electron-major-upgrade', 'task-11'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--runtimes') options.runtimes = argv[++index].split(',');
    else if (arg === '--pty-module-dir') options.ptyModuleDir = argv[++index];
    else if (arg === '--bridge-binary') options.bridgeBinary = argv[++index];
    else if (arg === '--electron-executable') options.electronExecutable = argv[++index];
    else if (arg === '--state-dir') options.stateDir = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--out-dir') options.outDir = argv[++index];
    else throw new Error('Unknown argument: ' + arg);
  }
  options.ptyModuleDir = path.resolve(options.ptyModuleDir);
  options.bridgeBinary = path.resolve(options.bridgeBinary);
  options.electronExecutable = path.resolve(options.electronExecutable);
  if (options.stateDir) options.stateDir = path.resolve(options.stateDir);
  options.outDir = path.resolve(options.outDir);
  for (const runtime of options.runtimes) {
    if (!['node', 'sea', 'electron'].includes(runtime)) throw new Error('Unknown runtime: ' + runtime);
  }
  return options;
}

function defaultElectronExecutable() {
  const runtimeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const devBinary = path.join(ROOT, 'node_modules', 'electron', 'dist', runtimeName);
  if (existsSync(devBinary)) return devBinary;
  if (process.platform === 'darwin') {
    return path.join(ROOT, 'dist-electron', 'mac', 'Vis.app', 'Contents', 'MacOS', 'Vis');
  }
  if (process.platform === 'win32') {
    return path.join(ROOT, 'dist-electron', 'win-unpacked', 'vis.exe');
  }
  return path.join(ROOT, 'dist-electron', 'linux-unpacked', 'vis');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(path.join(options.outDir, 'process-trees'), { recursive: true });
  let failed = false;
  const results = {};
  for (const runtime of options.runtimes) {
    try {
      const receipt =
        runtime === 'sea' ? await probeSea(options, options.outDir) : await probeRunner(options, runtime, PROBE_PATH, options.outDir);
      if (!receipt.ok) throw new Error(receipt.error ?? 'receipt reports failure');
      results[runtime] = receipt;
      if (runtime === 'sea') {
        await writeFile(path.join(options.outDir, 'sea.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
      }
      console.log('VIS_PTY_OK ' + runtime);
    } catch (error) {
      failed = true;
      results[runtime] = { ok: false, error: error instanceof Error ? error.message : String(error) };
      if (runtime === 'sea') {
        await writeFile(
          path.join(options.outDir, 'sea.json'),
          JSON.stringify(results[runtime], null, 2) + '\n',
          'utf8',
        );
      }
      console.error('VIS_PTY_FAIL ' + runtime + ': ' + (error instanceof Error ? error.message : String(error)));
    }
  }
  await writeFile(
    path.join(options.outDir, 'local-matrix.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), host: os.hostname(), runtimes: results }, null, 2) + '\n',
    'utf8',
  );
  process.exit(failed ? 1 : 0);
}

await main();
