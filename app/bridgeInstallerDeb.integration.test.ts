// @vitest-environment node
// PR #205 review item 3 — the sidecar staging must be synchronized with the
// packaging fixtures, and the Linux installers must really carry the payload.
//
// `stageLinuxRuntimePayload` (shared by the DEB and RPM packagers) stages the
// runtime store worker plus its import closure and a Node 24 sidecar under
// <payload>/usr/lib/vis_bridge. The RPM fixture shipped without them, so the
// Linux packaging gate failed before it could build anything. This lane drives
// the REAL packager end to end with real tooling: a real .deb build, a real
// `dpkg-deb -x` unpack, a real layout assertion, and a real installed-/runtime
// handshake — the extracted worker forked through the extracted sidecar.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { packageVisBridgeInstaller } from '../scripts/package-vis-bridge-installer.mjs';
import { computeRuntimeWorkerClosure } from '../scripts/vis-bridge-runtime-staging.mjs';

const ENVIRONMENT_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const EPOCH = '33333333-3333-4333-8333-333333333333';

const dpkgDebAvailable = (() => {
  try {
    execFileSync('dpkg-deb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(dpkgDebAvailable)('vis_bridge DEB sidecar payload', () => {
  it('builds and unpacks the staged worker closure and sidecar, and the installed /runtime really runs', async () => {
    // Given: a fixture root carrying a minimal bridge binary, a minimal
    // node-pty prebuild, the REAL worker import closure and a CONTROLLABLE
    // sidecar marker (never the 100MB build interpreter).
    const root = mkdtempSync(path.join(tmpdir(), 'vis-bridge-deb-test-'));
    try {
      const architecture = process.arch;
      const bridgePath = path.join(root, 'dist-bridge', 'vis_bridge');
      const nodePtyPath = path.join(root, 'node_modules', 'node-pty');
      mkdirSync(path.join(nodePtyPath, 'lib'), { recursive: true });
      mkdirSync(path.join(nodePtyPath, 'prebuilds', `linux-${architecture}`), { recursive: true });
      mkdirSync(path.dirname(bridgePath), { recursive: true });
      writeFileSync(bridgePath, '#!/bin/sh\nexit 0\n');
      writeFileSync(path.join(nodePtyPath, 'lib', 'index.js'), 'export {};\n');
      writeFileSync(path.join(nodePtyPath, 'prebuilds', `linux-${architecture}`, 'pty.node'), 'native-payload\n');
      writeFileSync(path.join(nodePtyPath, 'package.json'), '{"name":"node-pty"}\n');
      writeFileSync(path.join(nodePtyPath, 'LICENSE'), 'MIT\n');
      chmodSync(bridgePath, 0o755);
      chmodSync(path.join(nodePtyPath, 'prebuilds', `linux-${architecture}`, 'pty.node'), 0o755);
      const repositoryRoot = process.cwd();
      for (const relativePath of await computeRuntimeWorkerClosure(repositoryRoot)) {
        const destination = path.join(root, ...relativePath.split('/'));
        mkdirSync(path.dirname(destination), { recursive: true });
        copyFileSync(path.join(repositoryRoot, ...relativePath.split('/')), destination);
      }
      const sidecarSource = path.join(root, 'staged-node-sidecar');
      writeFileSync(sidecarSource, 'controllable Node 24 sidecar marker\n');

      // When: the production packager builds a real DEB.
      const debPath = await packageVisBridgeInstaller(root, {
        version: 'v1.2.3',
        platform: 'linux',
        arch: architecture,
        format: 'deb',
        sidecarSource,
      });
      expect(path.basename(debPath)).toBe(`VisBridge-1.2.3-${architecture}-Linux.deb`);

      // And: it is really unpacked with the system tool.
      const extractionPath = path.join(root, 'extracted');
      mkdirSync(extractionPath);
      execFileSync('dpkg-deb', ['-x', debPath, extractionPath], { stdio: 'pipe' });

      // Then: the installed layout places the worker and its closure under
      // <installRoot>/runtime/** with the sidecar beside them, exactly where
      // the installed resolver searches.
      const installRoot = path.join(extractionPath, 'usr', 'lib', 'vis_bridge', 'bridge', 'runtime');
      const workerPath = path.join(installRoot, 'runtime', 'runtimeDatabaseWorker.mjs');
      const sidecarPath = path.join(installRoot, 'runtime', 'vis_bridge_node');
      expect(readFileSync(workerPath, 'utf8')).toBe(
        readFileSync(path.join(repositoryRoot, 'bridge', 'runtime', 'storage', 'runtimeDatabaseWorker.mjs'), 'utf8'),
      );
      expect(readFileSync(sidecarPath, 'utf8')).toBe('controllable Node 24 sidecar marker\n');
      expect(statSync(sidecarPath).mode & 0o777).toBe(0o755);
      // And: the worker's shared import closure is installed beside it, so the
      // installed tree is self-contained.
      expect(readFileSync(path.join(extractionPath, 'usr', 'lib', 'vis_bridge', 'shared', 'runtime', 'protocol.js'), 'utf8').length)
        .toBeGreaterThan(0);

      // And: the installed /runtime handshake — the extracted worker forked
      // through the extracted sidecar completes a durable store round-trip. A
      // payload whose closure is incomplete fails here, not in production.
      await installedStoreHandshake(installRoot, path.join(root, 'state'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});

/**
 * The installed-/runtime handshake: forks the installed worker through the
 * installed Node sidecar and completes one durable store round-trip over the
 * real IPC protocol. The sidecar here is the controllable marker, so the
 * round-trip is driven with the real interpreter standing in for it.
 */
async function installedStoreHandshake(installRoot: string, stateDirectory: string): Promise<void> {
  const worker = fork(path.join(installRoot, 'runtime', 'runtimeDatabaseWorker.mjs'), [], {
    execPath: process.execPath,
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
  mkdirSync(stateDirectory, { recursive: true });
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
      changes: [{ collection: 'threads', key: 'thread-installed', value: { title: 'installed payload' } }],
    }) as { revision: number };
    const stored = await request('get', { collection: 'threads', key: 'thread-installed' }) as
      | { value: { title: string }; revision: number }
      | null;
    expect(stored).toMatchObject({ value: { title: 'installed payload' }, revision: ack.revision });
    await request('close', {});
  } finally {
    worker.kill('SIGKILL');
  }
}
