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
// platform shell (process.env.COMSPEC, i.e. cmd.exe by default; PowerShell
// as fallback) and process enumeration goes through Get-CimInstance
// Win32_Process with a parent/child walk; Windows process-tree behavior stays
// covered by the existing processTree.windows.test.ts regression, never
// weakened.
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

const SENTINEL_MARKER = 'VIS_PTY_OK_42'; // produced by a computed token; terminal echo cannot satisfy it
const STTY_EXPECTED = '40 100';
const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PROBE_PATH = fileURLToPath(new URL('./pty-runtime-probe.mjs', import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

// Platform shell: bash on POSIX (interactive job control forwards SIGHUP so
// the child-tree cleanup assertion is deterministic), the OS shell on Windows
// (ComSpec — cmd.exe by default; PowerShell only if ComSpec is unset).
const platformShell = () => (IS_WINDOWS ? process.env.COMSPEC || 'powershell.exe' : 'bash');

// ---------------------------------------------------------------------------
// Process enumeration — platform-aware. POSIX rows come straight from
// `ps -eo pid,ppid,pgid,stat,args`; Windows rows are synthesized from
// `Get-CimInstance Win32_Process` into the SAME "pid ppid pgid stat args"
// shape so every consumer (shell lookup, descendant walks, daemon-stop wait)
// is platform-agnostic.
// ---------------------------------------------------------------------------
function psAllPosix() {
  return execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,args'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function psAllWindows() {
  let json;
  try {
    json = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
    );
  } catch (error) {
    // Best-effort: a missing/broken powershell degrades to an empty snapshot
    // (the daemon-stop wait then treats the pid as gone).
    console.error('VIS_PTY_WARN windows process enumeration failed: ' + String(error?.message ?? error));
    return [];
  }
  const rows = json.trim() ? JSON.parse(json) : [];
  const list = Array.isArray(rows) ? rows : [rows];
  return list
    .filter((p) => p && typeof p.ProcessId === 'number')
    .map((p) => [p.ProcessId, p.ParentProcessId ?? 0, 0, 0, p.Name ?? '', p.CommandLine ?? ''].join(' '));
}

const psAll = () => (IS_WINDOWS ? psAllWindows() : psAllPosix());
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

// Kill a process and its descendants by PID (platform-aware). Never by name:
// a name/path pattern in our own command line would match ourselves.
function killProcessTree(rootPid) {
  if (IS_WINDOWS) {
    try {
      execFileSync('taskkill', ['/PID', String(rootPid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // process already gone
    }
    return;
  }
  const pids = [...new Set([rootPid, ...descendants(psAll(), rootPid)])];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH: already gone
    }
  }
}

// Background `sleep 300` jobs that are currently descendants of the daemon —
// captured while still in-tree so teardown can kill them by PID on any path.
function findSleepPids(rows, daemonPid) {
  const tree = new Set(descendants(rows, daemonPid));
  return rows
    .filter((row) => {
      const parts = row.trim().split(/\s+/);
      if (parts.length < 5 || !tree.has(Number(parts[0]))) return false;
      return /\bsleep\s+300(\s|$)/.test(parts.slice(4).join(' '));
    })
    .map((row) => Number(row.trim().split(/\s+/)[0]));
}

// Sentinel written by a command whose OUTPUT contains the marker while its
// echoed input lines never do — a computed token, so terminal echo alone
// cannot satisfy the assertion:
//   POSIX      echo VIS_PTY_OK_$((7*6))        (shell arithmetic expands to 42)
//   cmd.exe    value set on a PRIOR line       (%VIS_SENT% expands at parse
//              time of each line, so the value must come from an earlier line)
//   powershell $VIS_MARK = 'VIS_PTY_OK_' + ... (echoed assignment holds only
//              the prefix; expansion happens at execution)
function sentinelCommand(shellCommand) {
  const base = path.basename(shellCommand).toLowerCase();
  if (base === 'powershell.exe' || base === 'pwsh.exe') {
    return "$VIS_SENT = 6 * 7\r\n$VIS_MARK = 'VIS_PTY_OK_' + $VIS_SENT\r\necho $VIS_MARK";
  }
  if (IS_WINDOWS) {
    return 'set VIS_SENT=42\r\nset VIS_MARK=VIS_PTY_OK_%VIS_SENT%\r\necho %VIS_MARK%';
  }
  return 'echo VIS_PTY_OK_$((7*6))';
}

async function runProbe(probePath, args, receiptPath, outDir, label, treeName) {
  await dumpTree(treeName + '-before', outDir);
  const child = spawn(probePath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  try {
    // Watchdog: an absolute budget on the RECEIPT, raced against the probe's
    // exit — a probe that neither exits NOR writes its receipt within the
    // budget is a hang and is killed in the finally below.
    await Promise.race([
      exited.then(() => undefined),
      waitForFile(receiptPath, 90000, label).then(() => undefined),
    ]);
  } finally {
    // Kill a probe that is still alive when its receipt appeared (or after
    // the budget expired): its pty master closing then SIGHUPs the spawned
    // shell and its jobs. Kill by PID, platform-aware, never by name.
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      killProcessTree(child.pid);
    }
    try {
      await dumpTree(treeName + '-after', outDir);
    } catch {
      // evidence dump is best-effort
    }
  }
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
  let daemon;
  try {
    daemon = JSON.parse(await waitForFile(path.join(stateDir, 'daemon.json'), 30000, 'daemon start'));
  } catch (error) {
    throw new Error(
      'bridge daemon never published ' + path.join(stateDir, 'daemon.json') + ': ' + String(error),
    );
  }
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await bridgeRequest(daemon.port, 'GET', '/api/v1/supervisor');
      if (response.ok) return daemon;
    } catch {}
    await wait(200);
  }
  // The daemon IS running but not answering — attach it to the error so the
  // caller's teardown can still stop it.
  const error = new Error(
    'bridge daemon did not answer on port ' + daemon.port + ' (pid ' + daemon.pid + ')',
  );
  error.daemon = daemon;
  throw error;
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

function findPtyShellRow(rowsBefore, rowsAfter, daemonPid, shellCommand) {
  const shellBase = path.basename(shellCommand).toLowerCase();
  const before = new Set(
    rowsBefore
      .filter((row) => row.trim().split(/\s+/)[1] === String(daemonPid))
      .map((row) => row.trim()),
  );
  return rowsAfter.find((row) => {
    const parts = row.trim().split(/\s+/);
    if (parts.length < 5 || parts[1] !== String(daemonPid) || before.has(row.trim())) return false;
    // Match the spawned shell by basename (bash / cmd.exe / powershell.exe),
    // never hardcoding `bash` — Windows shells differ.
    const args = parts.slice(4).join(' ').trim();
    const base = (args.split(/[\\/]/).pop() ?? '').toLowerCase();
    return base === shellBase;
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
    binary: { path: options.bridgeBinary },
    ok: false,
  };
  let daemon = null;
  let ptyId = null;
  let ws = null;
  let shellPid = null;
  const sleepPids = [];
  const teardown = [];
  try {
    const binaryBuffer = await readFile(options.bridgeBinary);
    receipt.binary.sizeBytes = binaryBuffer.length;
    receipt.binary.embeddedNodeStrings = [
      ...new Set(binaryBuffer.toString('latin1').match(/v24\.\d+\.\d+/g) ?? []),
    ].slice(0, 8);
    await dumpTree('sea-before', outDir);
    daemon = await startBridgeDaemon(options.bridgeBinary, port, stateDir);
    receipt.daemon = { pid: daemon.pid, port: daemon.port, instanceId: daemon.instanceId };
    const shellCommand = platformShell();
    const rows0 = psAll();
    const createResponse = await bridgeRequest(daemon.port, 'POST', '/pty', {
      command: shellCommand,
      cols: 80,
      rows: 24,
    });
    if (!createResponse.ok) throw new Error('POST /pty failed: ' + createResponse.status);
    ptyId = (await createResponse.json()).id;
    await wait(400);
    const rows1 = psAll();
    const shellRow = findPtyShellRow(rows0, rows1, daemon.pid, shellCommand);
    if (!shellRow) {
      throw new Error(
        'PTY shell not found among daemon children; new children: ' +
          JSON.stringify(newDaemonChildren(rows0, rows1, daemon.pid)),
      );
    }
    shellPid = Number(shellRow.trim().split(/\s+/)[0]);
    receipt.spawn = { ptyId, shellPid, command: shellCommand };
    ws = new WebSocket('ws://127.0.0.1:' + daemon.port + '/pty/' + encodeURIComponent(ptyId) + '/connect');
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('pty websocket connect failed'));
    });
    if (!IS_WINDOWS) {
      // Cancellable background job: capture its PID while it is still a
      // daemon-tree descendant so teardown can kill it by PID on any path.
      ws.send('sleep 300 &\n');
      await wait(400);
      for (const pid of findSleepPids(psAll(), daemon.pid)) {
        if (!sleepPids.includes(pid)) sleepPids.push(pid);
      }
    }
    // Sentinel written by a computed token (see sentinelCommand): the echoed
    // input line never contains the literal marker, so terminal echo alone
    // cannot satisfy the assertion.
    const sentinel = waitForWebSocketOutput(ws, SENTINEL_MARKER, 15000, 'sea sentinel');
    ws.send(sentinelCommand(shellCommand) + (IS_WINDOWS ? '\r\n' : '\n'));
    await sentinel;
    receipt.sentinel = {
      ok: true,
      marker: SENTINEL_MARKER,
      producedBy: 'computed token; terminal echo cannot satisfy',
    };
    const resizeResponse = await bridgeRequest(daemon.port, 'PUT', '/pty/' + encodeURIComponent(ptyId), {
      size: { rows: 40, cols: 100 },
    });
    if (!resizeResponse.ok) throw new Error('PUT /pty resize failed: ' + resizeResponse.status);
    if (IS_WINDOWS) {
      // stty is POSIX-only; `mode con` behavior over ConPTY is not asserted
      // until a Windows runner confirms it. Reported explicitly unverified.
      receipt.resize = {
        ok: true,
        verified: false,
        note: 'no stty on Windows; PUT-200 + processTree.windows.test.ts regression cover resize',
      };
    } else {
      const resized = waitForWebSocketOutput(ws, STTY_EXPECTED, 15000, 'sea resize');
      ws.send('stty size\n');
      await resized;
      receipt.resize = { ok: true, rows: 40, cols: 100, verifiedVia: 'stty size' };
    }
    if (IS_WINDOWS) {
      const deleteResponse = await bridgeRequest(daemon.port, 'DELETE', '/pty/' + encodeURIComponent(ptyId));
      if (!deleteResponse.ok) throw new Error('DELETE /pty failed: ' + deleteResponse.status);
      receipt.kill = { ok: true };
      receipt.childTree = {
        checked: false,
        note: 'Windows process-tree covered by processTree.windows.test.ts regression',
      };
    } else {
      // Snapshot the pre-kill tree (shell + `sleep 300` job) BEFORE the
      // DELETE, then assert nothing of it survives: the kill must reap the
      // whole child tree, not just the shell.
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
    }
    receipt.ok = true;
  } catch (error) {
    // A partially-started daemon (published daemon.json but never answered)
    // is attached to the thrown error so teardown below can still stop it.
    if (daemon === null && error !== null && typeof error === 'object' && error.daemon) {
      daemon = error.daemon;
    }
    receipt.ok = false;
    receipt.error = error instanceof Error ? error.message : String(error);
  } finally {
    // Encompassing teardown on success AND failure: close the websocket,
    // DELETE the PTY, kill the cancellable sleep by captured PID, stop the
    // daemon, then snapshot the tree for evidence. Best-effort — never masks
    // the outcome recorded above.
    try {
      if (ws) {
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
      if (ptyId !== null && daemon) {
        try {
          const response = await bridgeRequest(daemon.port, 'DELETE', '/pty/' + encodeURIComponent(ptyId));
          teardown.push(response.ok ? 'pty-deleted' : 'pty-delete-status-' + response.status);
        } catch (error) {
          teardown.push('pty-delete-failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      for (const pid of sleepPids) {
        try {
          process.kill(pid, 'SIGKILL');
          teardown.push('sleep-' + pid + '-killed');
        } catch {
          // ESRCH: already dead
        }
      }
      if (daemon) {
        try {
          await stopBridgeDaemon(options.bridgeBinary, stateDir, daemon.pid);
          teardown.push('daemon-stopped');
        } catch (error) {
          teardown.push('daemon-stop-failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
    } catch (error) {
      teardown.push('teardown-aborted: ' + (error instanceof Error ? error.message : String(error)));
    }
    receipt.teardown = teardown;
    try {
      await dumpTree('sea-after', outDir);
    } catch {
      // evidence dump is best-effort
    }
  }
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
    if (runtime === 'sea') {
      // probeSea owns its teardown (encompassing finally) and returns the
      // receipt — failures are recorded WITH the teardown evidence, not lost.
      const receipt = await probeSea(options, options.outDir);
      results[runtime] = receipt;
      await writeFile(
        path.join(options.outDir, 'sea.json'),
        JSON.stringify(receipt, null, 2) + '\n',
        'utf8',
      );
      if (receipt.ok) {
        console.log('VIS_PTY_OK sea');
      } else {
        failed = true;
        console.error('VIS_PTY_FAIL sea: ' + (receipt.error ?? 'receipt reports failure'));
      }
      continue;
    }
    try {
      const receipt = await probeRunner(options, runtime, PROBE_PATH, options.outDir);
      if (!receipt.ok) throw new Error(receipt.error ?? 'receipt reports failure');
      results[runtime] = receipt;
      console.log('VIS_PTY_OK ' + runtime);
    } catch (error) {
      failed = true;
      results[runtime] = { ok: false, error: error instanceof Error ? error.message : String(error) };
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
