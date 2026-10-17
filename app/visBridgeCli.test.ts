import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  collectStartupFailures,
  createDaemonInvocation,
} from '../bridge/daemonController.js';
import {
  fingerprintDaemonCredentials,
  mergeDaemonRestartArgs,
  prepareDaemonLaunch,
} from '../bridge/daemonCredentials.js';
import { parseCliOptions } from '../vis_bridge';

describe('vis_bridge lifecycle commands', () => {
  it('selects the current config path for the editor command without parsing daemon credentials', () => {
    expect(parseCliOptions(['config', '--config', '/tmp/custom bridge.json'], {
      EDITOR: 'vi',
      VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
    })).toMatchObject({
      command: 'config',
      configPath: '/tmp/custom bridge.json',
    });
    expect(parseCliOptions(['config'], {
      EDITOR: 'vi', VIS_BRIDGE_CONFIG: '/tmp/env-bridge.json',
    })).toMatchObject({ command: 'config', configPath: '/tmp/env-bridge.json' });
    expect(() => parseCliOptions(['config', '--port', '23005'], {})).toThrow(
      'vis_bridge config does not accept --port',
    );
    expect(() => parseCliOptions(['config', '--config', ''], {})).toThrow(
      'vis_bridge config path must not be empty',
    );
  });

  it('maps legacy no-command and option-first invocations to daemon start', () => {
    expect(parseCliOptions([], {})).toMatchObject({ command: 'start', serverArgs: [] });
    expect(parseCliOptions(['--port', '23120'], {})).toMatchObject({
      command: 'start',
      port: 23120,
      serverArgs: ['--port', '23120'],
    });
  });

  it('separates direct secrets from persisted daemon launch arguments', () => {
    expect(
      prepareDaemonLaunch(
        ['--port', '23004', '--bridge-token=bridge-secret', '--upstream-token', 'upstream-secret'],
        {
          bridgeToken: 'bridge-secret',
          upstreamAuthorization: 'Bearer upstream-secret',
        },
      ),
    ).toEqual({
      launchArgs: ['--port', '23004'],
      requiredSecrets: ['bridgeToken', 'upstreamAuthorization'],
      secrets: {
        bridgeToken: 'bridge-secret',
        upstreamAuthorization: 'Bearer upstream-secret',
      },
    });
  });

  it('fingerprints both bridge and upstream credentials without persisting them', () => {
    const controlToken = 'control-token';
    const baseline = fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'bridge-token',
      upstreamAuthorization: 'Bearer upstream-token',
    });
    expect(fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'different-bridge-token',
      upstreamAuthorization: 'Bearer upstream-token',
    })).not.toBe(baseline);
    expect(fingerprintDaemonCredentials(controlToken, {
      bridgeToken: 'bridge-token',
      upstreamAuthorization: 'Bearer different-upstream-token',
    })).not.toBe(baseline);
    expect(baseline).not.toContain('bridge-token');
    expect(baseline).not.toContain('upstream-token');
  });

  it('merges credential-only restart overrides without duplicating persisted secret markers', () => {
    expect(
      mergeDaemonRestartArgs(
        ['--host=127.0.0.1', '--port=23120', '--upstream-token-file=/tmp/old-token'],
        ['--bridge-token=ipc'],
        ['bridgeToken'],
      ),
    ).toEqual([
      '--host=127.0.0.1',
      '--port=23120',
      '--upstream-token-file=/tmp/old-token',
      '--bridge-token=ipc',
    ]);
  });

  it('parses start options without treating the lifecycle command as a server argument', () => {
    expect(parseCliOptions(['start', '--port', '23120'], {})).toMatchObject({
      command: 'start',
      port: 23120,
      serverArgs: ['--port', '23120'],
    });
  });

  it('rejects server options on stop', () => {
    expect(() => parseCliOptions(['stop', '--port', '23120'], {})).toThrow(
      'vis_bridge stop does not accept --port',
    );
  });

  it('reports both native-service and ACP startup failures', () => {
    expect(
      collectStartupFailures({
        services: [
          {
            kind: 'native',
            name: 'OpenCode',
            state: 'error',
            error: 'opencode executable missing',
          },
        ],
        acpAgents: [
          {
            kind: 'acp',
            name: 'Broken ACP',
            state: 'error',
            error: 'agent executable missing',
          },
          { kind: 'acp', name: 'Healthy ACP', state: 'running' },
        ],
      }),
    ).toEqual([
      { kind: 'native', name: 'OpenCode', error: 'opencode executable missing' },
      { kind: 'acp', name: 'Broken ACP', error: 'agent executable missing' },
    ]);
  });

  it('recognizes a relative SEA argv path as the executable itself', () => {
    expect(
      createDaemonInvocation({
        entryPath: './dist-bridge/vis_bridge',
        execPath: path.resolve('dist-bridge/vis_bridge'),
        serverArgs: ['--port', '23120'],
      }),
    ).toEqual({
      command: path.resolve('dist-bridge/vis_bridge'),
      args: ['__daemon', '--port', '23120'],
    });
  });

  it('does not read a stale token file when a higher-priority authorization is present', () => {
    expect(
      parseCliOptions(['start'], {
        VIS_BRIDGE_CODEX_AUTHORIZATION: 'Basic dXNlcjpwYXNz',
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
      }),
    ).toMatchObject({ upstreamAuthorization: 'Basic dXNlcjpwYXNz' });
    expect(
      parseCliOptions(['--help'], {
        VIS_BRIDGE_CODEX_TOKEN_FILE: '/missing/stale-token-file',
      }),
    ).toMatchObject({ help: true, serverArgs: [] });
  });

  it('materializes environment-derived options as secret-free daemon arguments', () => {
    const options = parseCliOptions(['start'], {
      VIS_BRIDGE_HOST: '127.0.0.2',
      VIS_BRIDGE_PORT: '23113',
      VIS_BRIDGE_PATH: '/env-path',
      VIS_BRIDGE_CODEX_WS_URL: 'ws://127.0.0.1:4513',
      VIS_BRIDGE_CONFIG: '/tmp/env-config.json',
      VIS_BRIDGE_TOKEN: 'bridge-secret',
      VIS_BRIDGE_CODEX_AUTHORIZATION: 'Basic dXNlcjpwYXNz',
    });

    expect(options).toMatchObject({
      hasDaemonConfiguration: true,
      daemonArgs: [
        '--host=127.0.0.2',
        '--port=23113',
        '--path=/env-path',
        '--target=ws://127.0.0.1:4513',
        '--config=/tmp/env-config.json',
        '--bridge-token=ipc',
        '--upstream-token=ipc',
      ],
    });
    if (!('daemonArgs' in options)) throw new Error('Expected daemon arguments.');
    expect(JSON.stringify(options.daemonArgs)).not.toContain('bridge-secret');
    expect(JSON.stringify(options.daemonArgs)).not.toContain('dXNlcjpwYXNz');
  });

  it('persists the selected upstream token-file source instead of converting it to a direct secret', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-bridge-token-file-'));
    const tokenPath = path.join(directory, 'token');
    writeFileSync(tokenPath, 'file-token\n');
    try {
      expect(parseCliOptions(['start', '--upstream-token-file', tokenPath], {})).toMatchObject({
        daemonArgs: expect.arrayContaining([`--upstream-token-file=${tokenPath}`]),
        daemonSecretArgs: [`--upstream-token-file=${tokenPath}`],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects target URLs that could expose embedded credentials through process arguments', () => {
    for (const target of [
      'wss://user:password@example.test/codex',
      'wss://example.test/codex?access_token=secret',
      'wss://example.test/codex#secret',
    ]) {
      expect(() => parseCliOptions(['start', '--target', target], {})).toThrow(
        'must not include credentials, query parameters, or fragments',
      );
    }
  });

  it('rejects malformed target URLs before daemon lifecycle changes begin', () => {
    expect(() => parseCliOptions(['restart', '--target', 'not-a-websocket-url'], {})).toThrow(
      'Invalid vis_bridge target URL.',
    );
  });

  it('launches a SEA as itself even when argv uses a bare or differently-cased path', () => {
    for (const entryPath of ['vis_bridge', String.raw`C:\Program Files\VIS\VIS_BRIDGE.EXE`]) {
      expect(
        createDaemonInvocation({
          entryPath,
          execPath: String.raw`c:\program files\vis\vis_bridge.exe`,
          serverArgs: ['--port', '23120'],
          isSea: true,
        }),
      ).toEqual({
        command: String.raw`c:\program files\vis\vis_bridge.exe`,
        args: ['__daemon', '--port', '23120'],
      });
    }
  });
});

const CONTROL_STORE_ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const controlStoreCliPath = path.resolve(import.meta.dirname, '../vis_bridge.js');

function spawnControlStore(stateRoot: string) {
  return spawn(
    process.execPath,
    [
      controlStoreCliPath,
      'control-store',
      '--state-root',
      stateRoot,
      '--environment',
      CONTROL_STORE_ENVIRONMENT,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function waitForControlStoreOwnership(child: ChildProcess, timeoutMs = 8_000): Promise<string> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('control-store child has no stdout pipe.');
  let output = '';
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error);
      else resolve(output);
    };
    const timer = setTimeout(
      () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for control-store ownership; stdout=${JSON.stringify(output)}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.includes('control-store owns')) finish();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`control-store exited before claiming ownership (code=${code}, signal=${signal}); stdout=${JSON.stringify(output)}`));
    };
    stdout.on('data', onData);
    child.once('exit', onExit);
  });
}

async function readControlStoreFence(stateRoot: string): Promise<{ released: boolean; pid?: number }> {
  return JSON.parse(await readFile(path.join(stateRoot, 'fence.json'), 'utf8')) as {
    released: boolean;
    pid?: number;
  };
}

function processIsAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const visBridgeCliModuleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../bridge/visBridgeCli.js')).href;

/**
 * Preloaded into a real control-store child to hold the fsync of the `store.opened` journal
 * record: the window after the fence write has landed and before the store marks itself
 * opened. It patches the FileHandle prototype because the store module holds its own binding
 * of `fs/promises.open`, which a module-export patch cannot reach.
 */
const CONTROL_STORE_BARRIER_SOURCE = `
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { open } from 'node:fs/promises';

const barrierDirectory = process.env.VIS_TEST_CONTROL_STORE_BARRIER_DIR;
if (!barrierDirectory) throw new Error('VIS_TEST_CONTROL_STORE_BARRIER_DIR is required.');
const armedPath = path.join(barrierDirectory, 'armed');
const goPath = path.join(barrierDirectory, 'go');

const probe = await open(path.join(barrierDirectory, 'probe'), 'w');
const handlePrototype = Object.getPrototypeOf(probe);
await probe.close();
const originalWriteFile = handlePrototype.writeFile;
const originalSync = handlePrototype.sync;
const openingRecordWrites = new WeakMap();
handlePrototype.writeFile = async function patchedWriteFile(data, ...rest) {
  const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
  if (text.includes('"type":"store.opened"')) openingRecordWrites.set(this, true);
  return originalWriteFile.call(this, data, ...rest);
};
handlePrototype.sync = async function patchedSync(...args) {
  if (openingRecordWrites.get(this) === true) {
    writeFileSync(armedPath, '');
    while (!existsSync(goPath)) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return originalSync.apply(this, args);
};
`;

/**
 * Calls the real `runControlStoreCommand` against a state root whose ownership lock is held
 * by a live foreign holder, so the open fails after the CLI has installed its process
 * listeners, and reports how many listeners survived the failure.
 */
const CONTROL_STORE_OPEN_FAILURE_DRIVER_SOURCE = `
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runControlStoreCommand } from ${JSON.stringify(visBridgeCliModuleUrl)};

const environmentId = ${JSON.stringify(CONTROL_STORE_ENVIRONMENT)};
const stateRoot = mkdtempSync(path.join(tmpdir(), 'vis-control-store-open-failure-'));
mkdirSync(path.join(stateRoot, 'owner.lock'), { recursive: true });
writeFileSync(
  path.join(stateRoot, 'owner.lock', 'owner.json'),
  JSON.stringify({
    schemaVersion: 1,
    environmentId,
    ownerInstanceId: 'foreign-owner',
    pid: process.pid,
    lockId: 'foreign-lock',
    epoch: 0,
    acquiredAt: new Date().toISOString(),
  }),
  'utf8',
);
let failure = null;
try {
  await runControlStoreCommand({ stateRoot, environmentId });
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({
  failure,
  listeners: {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
  },
}));
`;

async function waitForControlStoreBarrier(child: ChildProcess, barrierDirectory: string, timeoutMs = 10_000): Promise<void> {
  const armedPath = path.join(barrierDirectory, 'armed');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(armedPath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`control-store exited before the startup barrier armed (code=${child.exitCode}, signal=${child.signalCode}).`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for the startup barrier to arm.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('vis_bridge control-store process lifecycle', { timeout: 20_000 }, () => {
  const children: ChildProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.pid !== undefined) child.kill('SIGKILL');
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('stays alive after claiming ownership and releases the fence on SIGTERM', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-control-store-term-'));
    roots.push(stateRoot);
    const child = spawnControlStore(stateRoot);
    children.push(child);

    await waitForControlStoreOwnership(child);
    const claimed = await readControlStoreFence(stateRoot);
    expect(claimed.released).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(child.exitCode).toBeNull();
    expect(processIsAlive(child.pid)).toBe(true);

    child.kill('SIGTERM');
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(code).toBe(0);

    const released = await readControlStoreFence(stateRoot);
    expect(released.released).toBe(true);
  });

  it('releases the fence on SIGINT and exits 0', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-control-store-int-'));
    roots.push(stateRoot);
    const child = spawnControlStore(stateRoot);
    children.push(child);

    await waitForControlStoreOwnership(child);
    expect((await readControlStoreFence(stateRoot)).released).toBe(false);

    child.kill('SIGINT');
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect((await readControlStoreFence(stateRoot)).released).toBe(true);
  });

  it('releases the fence when a signal lands after the fence write but before the open completes', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-control-store-startup-'));
    roots.push(stateRoot);
    const barrierDirectory = await mkdtemp(path.join(tmpdir(), 'vis-control-store-barrier-'));
    roots.push(barrierDirectory);
    const barrierPath = path.join(barrierDirectory, 'journal-barrier.mjs');
    await writeFile(barrierPath, CONTROL_STORE_BARRIER_SOURCE, 'utf8');
    const child = spawn(
      process.execPath,
      [
        '--import',
        pathToFileURL(barrierPath).href,
        controlStoreCliPath,
        'control-store',
        '--state-root',
        stateRoot,
        '--environment',
        CONTROL_STORE_ENVIRONMENT,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VIS_TEST_CONTROL_STORE_BARRIER_DIR: barrierDirectory },
      },
    );
    children.push(child);

    // Armed only between the fence write and the fsync that completes the open: the fence is
    // already on disk and the ownership lock is held, but the store has not finished opening.
    await waitForControlStoreBarrier(child, barrierDirectory);
    expect((await readControlStoreFence(stateRoot)).released).toBe(false);
    expect(existsSync(path.join(stateRoot, 'owner.lock'))).toBe(true);

    child.kill('SIGINT');
    await writeFile(path.join(barrierDirectory, 'go'), '', 'utf8');

    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect((await readControlStoreFence(stateRoot)).released).toBe(true);
    expect(existsSync(path.join(stateRoot, 'owner.lock'))).toBe(false);
  });

  it('removes the installed process listeners when the open fails', async () => {
    const driverDirectory = await mkdtemp(path.join(tmpdir(), 'vis-control-store-driver-'));
    roots.push(driverDirectory);
    const driverPath = path.join(driverDirectory, 'open-failure-driver.mjs');
    await writeFile(driverPath, CONTROL_STORE_OPEN_FAILURE_DRIVER_SOURCE, 'utf8');
    const child = spawn(process.execPath, [driverPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    const [code] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(code).toBe(0);

    const report = JSON.parse(stdout.trim()) as {
      failure: string | null;
      listeners: Record<string, number>;
    };
    expect(report.failure).toContain('conflict: store.fence');
    expect(report.listeners).toEqual({
      SIGINT: 0,
      SIGTERM: 0,
      uncaughtException: 0,
      unhandledRejection: 0,
    });
  });
});
