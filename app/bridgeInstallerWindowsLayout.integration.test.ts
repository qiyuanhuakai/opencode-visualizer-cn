// @vitest-environment node
// PR #205 review item 1 — the Windows NSIS installer must place the runtime
// store sidecar where the INSTALLED resolver searches for it.
//
// `package-vis-bridge-installer.mjs` staged the worker sidecar into
// <workspace>/bridge/runtime/runtime/** and its shared closure into
// <workspace>/shared/runtime/**, then emitted `File /r ".../bridge/*"` and
// `File /r ".../shared/*"` under $INSTDIR. Per NSIS `File` semantics the
// directory before the wildcard is the SEARCH ROOT and only its contents are
// copied under $OUTDIR, so the `bridge`/`shared` level was dropped: the worker
// landed at $INSTDIR/runtime/** (both trees even collided there) while
// `installedStoreRootCandidates` (bridge/runtime/storage/runtimeStore.js) only
// searches $INSTDIR\bridge\runtime — an installed Windows vis_bridge therefore
// always failed with "store sidecar is missing".
//
// This test composes the REAL generated NSIS script with the REAL sidecar
// staging, applies the documented NSIS File semantics to reconstruct the
// installed tree, and then runs the REAL resolver and a REAL store-worker
// handshake against that tree. `makensis` itself is not available on the Linux
// test host (nor on the Linux packaging lanes), so the install step is a
// faithful semantic reconstruction of the emitted script rather than a
// compiled installer; every other step is the production code path.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createWindowsInstallerScript } from '../scripts/package-vis-bridge-installer.mjs';
import { stageNodePtyRuntime } from '../scripts/vis-bridge-node-pty.mjs';
import { stageRuntimeWorkerSidecar } from '../scripts/vis-bridge-runtime-staging.mjs';
import { installedStoreRootCandidates } from '../bridge/runtime/storage/runtimeStore.js';

const REPO_ROOT = path.resolve(process.cwd());
const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const EPOCH = '33333333-3333-4333-8333-333333333333';

function installSectionLines(script: string): string[] {
  const lines = script.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Section "Install"');
  const end = lines.findIndex((line) => line.trim() === 'SectionEnd');
  if (start < 0 || end < 0 || end < start) throw new Error('NSIS install section was not found');
  return lines.slice(start + 1, end).map((line) => line.trim()).filter((line) => line.length > 0);
}

function uninstallSectionLines(script: string): string[] {
  const lines = script.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Section "Uninstall"');
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'SectionEnd');
  if (start < 0 || end < 0 || end < start) throw new Error('NSIS uninstall section was not found');
  return lines.slice(start + 1, end).map((line) => line.trim()).filter((line) => line.length > 0);
}

function resolveNsisPath(value: string, installDir: string, pluginsDir: string): string {
  // NSIS paths are Windows paths; the simulation runs on the POSIX test host,
  // so every separator is normalized before the tree is reconstructed.
  return value
    .replaceAll('$INSTDIR', installDir)
    .replaceAll('$PLUGINSDIR', pluginsDir)
    .replaceAll('\\', '/');
}

/**
 * Reconstructs the installed tree the emitted NSIS script produces, applying
 * the documented `File` semantics: the directory before the wildcard is the
 * search root and its contents are copied under the current $OUTDIR with the
 * structure BELOW that root preserved; `File /oname=x "src"` copies one file.
 * A missing source is an error, exactly as makensis would refuse the build.
 */
function simulateNsisInstall(script: string, installDir: string, pluginsDir: string): void {
  let outDir: string | null = null;
  for (const line of installSectionLines(script)) {
    const setOutPath = /^SetOutPath "(.*)"$/.exec(line);
    if (setOutPath) {
      outDir = resolveNsisPath(setOutPath[1]!, installDir, pluginsDir);
      mkdirSync(outDir, { recursive: true });
      continue;
    }
    const file = /^File (?:\/oname=(\S+) )?(\/r )?"(.*)"$/.exec(line);
    if (!file) continue;
    if (outDir === null) throw new Error(`File emitted before any SetOutPath: ${line}`);
    const [, oname, recursive, source] = file;
    const sourcePath = resolveNsisPath(source!, installDir, pluginsDir);
    if (recursive !== undefined) {
      const searchRoot = sourcePath.replace(/[^\\/]*$/, '');
      if (!existsSync(searchRoot)) throw new Error(`NSIS File search root does not exist: ${searchRoot}`);
      cpSync(searchRoot, outDir, { recursive: true });
    } else {
      if (!existsSync(sourcePath)) throw new Error(`NSIS File source does not exist: ${sourcePath}`);
      copyFileSync(sourcePath, path.join(outDir, oname ?? path.basename(sourcePath)));
    }
  }
}

function firstLevelDirectories(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry: Dirent) => entry.isDirectory())
    .map((entry: Dirent) => entry.name)
    .sort();
}

/**
 * The installed-/runtime handshake: forks the installed worker through the
 * installed Node 24 sidecar and completes one durable store round-trip over
 * the real IPC protocol. Both paths are spelled with the Windows names the
 * installed resolver demands, because the installed target is Windows and the
 * test host is POSIX. A worker whose import closure does not resolve from the
 * installed tree exits before it can answer, which fails the round-trip.
 */
async function installedStoreHandshake(installRoot: string, stateDirectory: string): Promise<void> {
  const worker = fork(path.join(installRoot, 'runtime', 'runtimeDatabaseWorker.mjs'), [], {
    execPath: path.join(installRoot, 'runtime', 'vis_bridge_node.exe'),
    execArgv: [],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  worker.on('message', (message: { id: number; ok: boolean; result?: unknown; error?: { code: string; reason: string } }) => {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(`${message.error?.code ?? 'unknown'}: ${message.error?.reason ?? 'unknown'}`));
  });
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('worker_timeout')); }, 15000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      worker.send({ id, method, params }, (error) => {
        if (error !== null && error !== undefined) reject(new Error(`worker_send: ${error.message}`));
      });
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (fail: () => void) => {
        worker.removeAllListeners('spawn');
        worker.removeAllListeners('exit');
        worker.removeAllListeners('error');
        fail();
      };
      worker.once('spawn', () => done(resolve));
      worker.once('exit', (code, signal) => done(() => reject(new Error(`worker_exit: ${code ?? signal}`))));
      worker.once('error', (error) => done(() => reject(new Error(`worker_spawn: ${error.message}`))));
    });
    const initialized = await request('initialize', {
      stateDirectory,
      environmentId: ENVIRONMENT_ID,
      ownerId: OWNER_ID,
      epoch: EPOCH,
    }) as { fence: number };
    expect(initialized.fence).toBe(1);
    const ack = await request('mutate', {
      intentId: 'intent-installed',
      changes: [{ collection: 'threads', key: 'thread-installed', value: { title: 'installed layout' } }],
    }) as { revision: number };
    const stored = await request('get', { collection: 'threads', key: 'thread-installed' }) as
      | { value: { title: string }; revision: number }
      | null;
    expect(stored).toMatchObject({ value: { title: 'installed layout' }, revision: ack.revision });
    await request('close', {});
  } finally {
    worker.kill('SIGKILL');
  }
}

describe('Windows NSIS installer layout and installed /runtime handshake', () => {
  it('installs the sidecar under $INSTDIR\\bridge\\runtime where the installed resolver searches, and the worker really runs from there', { timeout: 30_000 }, async () => {
    // Given: a staging workspace holding the REAL sidecar staging output
    // (worker + Node 24 sidecar + shared closure) produced by the production
    // staging module against the real repository sources.
    const root = mkdtempSync(path.join(tmpdir(), 'vis-bridge-nsis-test-'));
    try {
      const workspacePath = path.join(root, 'work');
      const installDir = path.join(root, 'install', 'vis_bridge');
      const pluginsDir = path.join(root, 'plugins');
      mkdirSync(workspacePath, { recursive: true });
      mkdirSync(installDir, { recursive: true });
      mkdirSync(pluginsDir, { recursive: true });
      const binaryPath = path.join(workspacePath, 'dist-bridge', 'vis_bridge.exe');
      mkdirSync(path.dirname(binaryPath), { recursive: true });
      writeFileSync(binaryPath, 'MZ staged bridge binary\n');
      writeFileSync(path.join(workspacePath, 'add-path.ps1'), 'param([string]$InstallDirectory)\n');
      writeFileSync(path.join(workspacePath, 'remove-path.ps1'), 'param([string]$InstallDirectory)\n');
      writeFileSync(path.join(workspacePath, 'stop-daemon.ps1'), 'stop\n');

      const staged = await stageRuntimeWorkerSidecar(REPO_ROOT, workspacePath, {
        platform: 'win32',
        sidecarSource: process.execPath,
      });
      // The Windows staging deliberately skips chmod; the Linux test host needs
      // the executable bit to fork the sidecar. This is test-host scaffolding,
      // not installer behaviour.
      chmodSync(staged.sidecarPath, 0o755);
      // The packager stages node-pty into the same workspace; the fixture root
      // carries a minimal prebuild so the emitted script's sources all exist,
      // exactly as makensis would require.
      const fixtureRoot = path.join(root, 'fixture');
      const nodePtySource = path.join(fixtureRoot, 'node_modules', 'node-pty');
      mkdirSync(path.join(nodePtySource, 'lib'), { recursive: true });
      mkdirSync(path.join(nodePtySource, 'prebuilds', 'win32-x64'), { recursive: true });
      writeFileSync(path.join(nodePtySource, 'package.json'), '{"name":"node-pty"}\n');
      writeFileSync(path.join(nodePtySource, 'LICENSE'), 'MIT\n');
      writeFileSync(path.join(nodePtySource, 'lib', 'index.js'), 'export {};\n');
      writeFileSync(path.join(nodePtySource, 'prebuilds', 'win32-x64', 'pty.node'), 'native-payload\n');
      await stageNodePtyRuntime(
        fixtureRoot,
        path.join(workspacePath, 'node_modules', 'node-pty'),
        'win32',
        'x64',
      );

      // When: the REAL installer script is generated for that workspace.
      const script = createWindowsInstallerScript({
        binaryPath,
        installerDirectory: path.join(root, 'installers'),
        installerPath: path.join(root, 'VisBridge-1.2.3-x64-Windows.exe'),
        workspacePath,
      });
      simulateNsisInstall(script, installDir, pluginsDir);

      // Then: the worker and its sidecar are installed under the bridge level
      // the resolver searches — <installRoot>/runtime/**.
      const workerPath = path.join(installDir, 'bridge', 'runtime', 'runtime', 'runtimeDatabaseWorker.mjs');
      const sidecarPath = path.join(installDir, 'bridge', 'runtime', 'runtime', 'vis_bridge_node.exe');
      expect(existsSync(workerPath)).toBe(true);
      expect(existsSync(sidecarPath)).toBe(true);
      // And: the shared closure is installed beside it, so the worker's own
      // relative specifiers resolve inside the install tree.
      expect(existsSync(path.join(installDir, 'shared', 'runtime', 'protocol.js'))).toBe(true);
      // And: the old flattening is gone — nothing landed at $INSTDIR/runtime.
      expect(existsSync(path.join(installDir, 'runtime'))).toBe(false);

      // And: the uninstall section removes every top-level directory the
      // install section creates (the old layout orphaned $INSTDIR/runtime).
      const removed = uninstallSectionLines(script)
        .map((line) => /^RMDir \/r "\$INSTDIR\\([^"]+)"$/.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => match[1]!);
      for (const directory of firstLevelDirectories(installDir)) {
        expect(removed).toContain(directory);
      }

      // And: the installed /runtime handshake. The resolver the SEA binary
      // runs at startup searches exactly the location the installer now
      // populates (compared in win32 terms, the resolver's own domain)...
      const candidates = installedStoreRootCandidates(path.join(installDir, 'vis_bridge.exe'), 'win32');
      expect(candidates).toContain(path.win32.join(installDir, 'bridge', 'runtime'));
      // ...and the installed worker really runs from that tree: the fork below
      // is what the installed Windows bridge performs at startup — the worker
      // entry plus its Node 24 sidecar under the resolved install root, both
      // spelled with the Windows names the installed resolver demands. The
      // import closure must resolve from the installed tree, or the worker
      // exits before it can answer.
      const stateDirectory = path.join(root, 'state');
      mkdirSync(stateDirectory, { recursive: true });
      await installedStoreHandshake(path.join(installDir, 'bridge', 'runtime'), stateDirectory);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
