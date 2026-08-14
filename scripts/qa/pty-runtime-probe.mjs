// PTY runtime probe — launched BY scripts/qa/node-pty-dual-runtime.mjs inside
// the target runtime: the system Node interpreter or an Electron 43 main
// process (the Electron runtime binary, which accepts an explicit script
// entry point; a packaged executable always runs its own asar main).
//
// Spawns the platform shell through node-pty, proves a sentinel round-trip
// (VIS_PTY_OK_42, produced by a COMPUTED token per platform — shell
// expansion at execution time, so the echoed input line never contains the
// marker and a terminal that only echoes input cannot satisfy the
// assertion), resizes (verified via `stty size` on POSIX), kills, and
// proves child-tree cleanup from a ps snapshot: no survivors, no zombies.
//
// argv: [moduleDir, receiptPath, workDir]
//   moduleDir  — the node-pty package directory to load (the RED contract
//                points this at a staged copy without its native prebuild)
//   receiptPath — JSON receipt written by this probe
//   workDir    — cwd for the spawned shell (must be absolute)
//
// Exit code: 0 on success, 1 on any failure.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const [moduleDir, receiptPath, workDir] = process.argv.slice(2);
const result = {
  runtime: process.versions.electron ? 'electron' : 'node',
  versions: {
    node: process.versions.node,
    modules: process.versions.modules,
    ...(process.versions.electron ? { electron: process.versions.electron } : {}),
  },
  platform: process.platform,
  arch: process.arch,
  ok: false,
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function psSnapshot() {
  if (process.platform === 'win32') return [];
  return execFileSync('ps', ['-eo', 'pid,ppid,pgid,stat,args'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
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

function processRow(rows, pid) {
  return rows.find((row) => row.trim().startsWith(String(pid) + ' '));
}

function zombiePids(rows, pids) {
  return pids.filter((pid) => {
    const row = processRow(rows, pid);
    return row !== undefined && row.includes('Z');
  });
}

async function waitForOutput(getText, marker, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getText().includes(marker)) return;
    await wait(100);
  }
  throw new Error(label + ' timed out; last output: ' + JSON.stringify(getText().slice(-200)));
}

(async () => {
  try {
    if (process.versions.electron) {
      const { app } = await import('electron');
      app.setPath('userData', workDir + '/electron-user-data');
      app.disableHardwareAcceleration();
      await app.whenReady();
    }
    const require = createRequire(import.meta.url);
    const pty = require(moduleDir); // RED lands here when the native prebuild is missing
    result.load = { ok: true };
    const isWindows = process.platform === 'win32';
    const command = isWindows ? process.env.COMSPEC || 'powershell.exe' : 'bash';
    const terminal = pty.spawn(command, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: process.env,
      cwd: workDir,
    });
    result.spawn = { pid: terminal.pid, command };
    let output = '';
    terminal.onData((data) => {
      output += String(data);
    });
    const exited = new Promise((resolve) => terminal.onExit((event) => resolve(event ?? {})));
    // Computed sentinel (same approach as the SEA path in
    // node-pty-dual-runtime.mjs sentinelCommand): the expected marker
    // VIS_PTY_OK_42 never appears in the echoed input lines — only shell
    // expansion at execution time produces it, so terminal echo alone can
    // never satisfy the assertion:
    //   bash        echo VIS_PTY_OK_$((7*6))   — arithmetic expands at
    //               execution; the echoed line holds `$((7*6))` verbatim
    //   cmd.exe     value set on a PRIOR line   — %VIS_SENT% expands at
    //               parse time of each line, so the value must come from an
    //               earlier line; the echoed `set` lines hold no marker
    //   powershell  $VIS_MARK built at runtime  — echoed assignment holds
    //               only the prefix `VIS_PTY_OK_`
    const marker = 'VIS_PTY_OK_42';
    const shellBase = path.basename(command).toLowerCase();
    const isPwsh = shellBase === 'powershell.exe' || shellBase === 'pwsh.exe';
    let sentinelInput;
    if (isPwsh) {
      sentinelInput = "$VIS_SENT = 6 * 7\r\n$VIS_MARK = 'VIS_PTY_OK_' + $VIS_SENT\r\necho $VIS_MARK";
    } else if (isWindows) {
      sentinelInput = 'set VIS_SENT=42\r\nset VIS_MARK=VIS_PTY_OK_%VIS_SENT%\r\necho %VIS_MARK%';
    } else {
      sentinelInput = 'echo VIS_PTY_OK_$((7*6))';
    }
    terminal.write(sentinelInput + (isWindows ? '\r\n' : '\n'));
    await waitForOutput(() => output, marker, 15000, 'sentinel');
    result.sentinel = { ok: true, marker, producedBy: 'computed token; terminal echo cannot satisfy' };
    terminal.resize(100, 40);
    if (isWindows) {
      result.resize = {
        ok: true,
        verified: false,
        note: 'stty unavailable on Windows; resize PUT-200 and processTree.windows.test.ts cover it',
      };
    } else {
      output = '';
      terminal.write('stty size\n');
      await waitForOutput(() => output, '40 100', 15000, 'resize');
      result.resize = { ok: true, rows: 40, cols: 100, verifiedVia: 'stty size' };
    }
    if (isWindows) {
      terminal.kill();
      await Promise.race([exited, wait(10000)]);
      result.kill = { ok: true, note: 'conpty kill; tree covered by existing regression' };
      result.childTree = {
        checked: false,
        note: 'Windows process-tree covered by processTree.windows.test.ts regression',
      };
    } else {
      terminal.write('sleep 300 &\n');
      await wait(600);
      const rowsBefore = psSnapshot();
      const treeBefore = descendants(rowsBefore, terminal.pid);
      terminal.kill();
      const exitEvent = await Promise.race([exited, wait(10000).then(() => null)]);
      await wait(1200);
      const rowsAfter = psSnapshot();
      const survivors = treeBefore.filter((pid) => processRow(rowsAfter, pid) !== undefined);
      const zombies = zombiePids(rowsAfter, treeBefore);
      result.kill = { ok: true, exitEvent };
      result.childTree = { checked: true, before: treeBefore, survivors, zombies };
      if (survivors.length > 0 || zombies.length > 0) {
        throw new Error(
          'child tree cleanup failed: survivors=' + JSON.stringify(survivors) + ' zombies=' + JSON.stringify(zombies),
        );
      }
    }
    result.ok = true;
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  }
  await writeFile(receiptPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
  if (process.versions.electron) {
    const { app } = await import('electron');
    app.exit(result.ok ? 0 : 1);
  } else {
    process.exit(result.ok ? 0 : 1);
  }
})();
