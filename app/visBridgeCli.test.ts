import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const controlStoreModulePath = path.resolve(import.meta.dirname, '../bridge/visBridgeCli.js');

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

  // The SIGINT test above is the shape a supervisor uses, but its fence read
  // between the ownership line and the signal gives the child a millisecond-scale
  // head start. The defect this lane closes registered the signal handlers AFTER
  // publishing ownership, so the tightest race — a signal delivered the instant
  // ownership is observable — hit the default disposition and killed the process
  // with the fence still held. CI reproduced it (the branch's own runs passed
  // three times and failed once with `expected 'SIGINT' to be null`); a direct
  // probe against the pre-fix code hard-killed 10 of 25 runs at this race.
  // Killing in the SAME tick the line is observed removes that head start, so the
  // regression cannot come back silently.
  it('releases the fence on a SIGINT delivered in the same tick ownership is published', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-control-store-int-tight-'));
    roots.push(stateRoot);
    const child = spawnControlStore(stateRoot);
    children.push(child);
    const stdout = child.stdout;
    if (!stdout) throw new Error('control-store child has no stdout pipe.');

    const ownership = new Promise<void>((resolve) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (!output.includes('control-store owns')) return;
        stdout.off('data', onData);
        child.kill('SIGINT');
        resolve();
      };
      stdout.on('data', onData);
    });
    await Promise.all([ownership, once(child, 'exit')]);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
    expect((await readControlStoreFence(stateRoot)).released).toBe(true);
  });

  // A repeat signal during the release must not terminate the process mid-write:
  // with `once`, the second SIGINT restored the default disposition and killed the
  // child before the fence was released (a direct probe against the pre-fix code
  // orphaned the fence in 7 of 10 runs). The release absorbs repeats instead.
  it('absorbs a repeat SIGINT during the release and still releases the fence', async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), 'vis-control-store-int-repeat-'));
    roots.push(stateRoot);
    const child = spawnControlStore(stateRoot);
    children.push(child);

    await waitForControlStoreOwnership(child);
    child.kill('SIGINT');
    child.kill('SIGINT');
    child.kill('SIGINT');
    const [code, signal] = (await once(child, 'exit')) as [number | null, NodeJS.Signals | null];
    expect(signal).toBeNull();
    expect(code).toBe(0);
    expect((await readControlStoreFence(stateRoot)).released).toBe(true);
  });
});

// The liveness timer is deliberately created BEFORE the store opens, because the
// signal handlers must be registered before ownership is published (the race the
// tests above lock down). That ordering makes an initialisation failure dangerous:
// the 2,147,483,647 ms interval is referenced, so nothing keeps the event loop from
// draining — the CLI prints the error and then stays resident forever, and a
// supervisor is left with a process that has already errored but never exits. A
// direct probe against the pre-fix head survived a 4 s external timeout on BOTH a
// real ENOTDIR and an initialisation rejection, while the pre-SIGINT-fix head
// self-terminated with code=1 in under 100 ms on both.
describe('vis_bridge control-store initialisation failure', { timeout: 30_000 }, () => {
  const children: ChildProcess[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.pid !== undefined) child.kill('SIGKILL');
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /**
   * Resolves with the child's exit once it happens, or null if it is still resident
   * after `timeoutMs`. The caller is responsible for killing a resident child.
   */
  async function awaitExitWithin(
    child: ChildProcess,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    try {
      return await Promise.race([
        once(child, 'exit').then(([code, signal]) => ({ code, signal }) as {
          code: number | null;
          signal: NodeJS.Signals | null;
        }),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function collectOutput(child: ChildProcess): Promise<{ stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    const exit = awaitExitWithin(child, 5_000);
    const result = await exit;
    if (result === null) {
      child.kill('SIGKILL');
      throw new Error(
        `control-store stayed resident after initialisation failed; stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
      );
    }
    return { stdout, stderr };
  }

  it('exits non-zero within a bounded time when the state root is not a directory', async () => {
    // An ordinary file where a directory is expected: the real directory error path.
    const root = await mkdtemp(path.join(tmpdir(), 'vis-control-store-enotdir-'));
    roots.push(root);
    await writeFile(path.join(root, 'not-directory'), 'not a directory\n');
    const child = spawnControlStore(path.join(root, 'not-directory', 'child'));
    children.push(child);

    const { stderr } = await collectOutput(child);
    expect(stderr).toContain('ENOTDIR');
    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
  });

  it('exits non-zero within a bounded time when initialisation rejects', async () => {
    // A live foreign fence makes `store.open` reject with a conflict — an
    // initialisation rejection rather than a filesystem error, proving the
    // residency defect is not specific to the ENOTDIR fixture. The foreign pid is
    // this test process, which stays alive for the whole run.
    const root = await mkdtemp(path.join(tmpdir(), 'vis-control-store-conflict-'));
    roots.push(root);
    await writeFile(
      path.join(root, 'fence.json'),
      JSON.stringify({
        schemaVersion: 1,
        environmentId: CONTROL_STORE_ENVIRONMENT,
        ownerInstanceId: 'foreign-owner-not-this-process',
        pid: process.pid,
        epoch: 1,
        released: false,
        openedAt: new Date().toISOString(),
      }),
    );
    const child = spawnControlStore(root);
    children.push(child);

    const { stderr } = await collectOutput(child);
    expect(stderr).toContain('conflict');
    expect(child.exitCode).toBe(1);
    expect(child.signalCode).toBeNull();
  });

  // The exit tests above prove the timer was reclaimed (a referenced interval is the
  // only thing holding the loop open), but a cleared timer alone would still leave the
  // four process listeners attached. This runs the real command in an isolated child
  // and reads the listener counts, so both halves of the cleanup are observable: the
  // child must exit at all (timer cleared) and must report no leaked listeners.
  it('clears the liveness timer and removes the process listeners when initialisation fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vis-control-store-listeners-'));
    roots.push(root);
    await writeFile(path.join(root, 'not-directory'), 'not a directory\n');
    const stateRoot = path.join(root, 'not-directory', 'child');

    const scriptDirectory = await mkdtemp(path.join(tmpdir(), 'vis-control-store-probe-'));
    roots.push(scriptDirectory);
    const scriptPath = path.join(scriptDirectory, 'probe.mjs');
    await writeFile(
      scriptPath,
      `import { runControlStoreCommand } from ${JSON.stringify(pathToFileURL(controlStoreModulePath).href)};
const count = (event) => process.listenerCount(event);
const events = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const before = Object.fromEntries(events.map((event) => [event, count(event)]));
let thrown = null;
try {
  await runControlStoreCommand({ stateRoot: ${JSON.stringify(stateRoot)}, environmentId: ${JSON.stringify(CONTROL_STORE_ENVIRONMENT)} });
} catch (error) {
  thrown = error instanceof Error ? error.message : String(error);
}
const after = Object.fromEntries(events.map((event) => [event, count(event)]));
console.log(JSON.stringify({ thrown, before, after }));
`,
    );

    const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });

    const exited = await awaitExitWithin(child, 5_000);
    if (exited === null) {
      child.kill('SIGKILL');
      throw new Error(
        'the control-store probe child stayed resident after initialisation failed, so the liveness timer was not reclaimed',
      );
    }
    expect(child.exitCode).toBe(0);

    const report = JSON.parse(stdout.trim()) as {
      thrown: string | null;
      before: Record<string, number>;
      after: Record<string, number>;
    };
    expect(report.thrown).toContain('ENOTDIR');
    expect(report.after).toEqual(report.before);
  });
});
