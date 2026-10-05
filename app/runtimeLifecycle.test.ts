import { mkdtemp, readFile, writeFile, rm, mkdir, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createBridgeRuntime } from '../bridge/bridgeRuntime.js';
import { createBridgeConfigStore } from '../bridge/bridgeConfig.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadEnvironmentIdentity } from '../bridge/runtime/environmentIdentity.js';
import { describe, expect, it } from 'vitest';
import { createRuntimeHost } from '../bridge/runtime/runtimeHost.js';

const environmentId = '11111111-1111-4111-8111-111111111111';
function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runtime lifecycle', () => {
  it.each(['pending', 'corrupt'])(
    'failure releases owned legacy children when host initialization is %s',
    async (mode) => {
      // Given a running legacy owner before lazy host identity initialization.
      const root = await mkdtemp(path.join(tmpdir(), 'vis-runtime-race-'));
      let child: ChildProcess | undefined;
      let nativeStops = 0;
      let acpStops = 0;
      const releaseChild = async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit');
          child.kill();
          await exited;
        }
      };
      const runtime = createBridgeRuntime({
        stateRoot: root,
        configStore: createBridgeConfigStore({ configPath: path.join(root, 'bridge.json') }),
        nativeSupervisor: {
          start: async () => {
            child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
              stdio: 'ignore',
            });
            await once(child, 'spawn');
            return [];
          },
          stop: async () => {
            nativeStops++;
            await releaseChild();
          },
          getStatus: () => [],
        },
        acpManager: {
          reconcile: async () => [],
          stopAll: async () => {
            acpStops++;
          },
          getStatus: () => [],
          attach: () => {},
        },
      });
      try {
        await runtime.start();
        if (mode === 'corrupt') {
          await mkdir(path.join(root, 'runtime'));
          await writeFile(path.join(root, 'runtime/environment.json'), '{broken');
        }
        if (!runtime.getRuntimeHost) throw new Error('Missing host API');
        const pending = expect(runtime.getRuntimeHost()).rejects.toThrow();
        // When shutdown races or follows a rejected host initializer.
        if (mode === 'corrupt') await pending;
        await runtime.stop();
        await pending;
        // Then both managers released and the actual owned process is gone.
        expect(nativeStops).toBe(1);
        expect(acpStops).toBe(1);
        const pid = child?.pid;
        if (!pid) throw new Error('Missing child PID');
        expect(() => process.kill(pid, 0)).toThrow();
        await runtime.stop();
        expect(nativeStops).toBe(1);
      } finally {
        await releaseChild();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it('failure aborts pending startup before releasing its resources', async () => {
    // Given a source waiting for cancellation during readiness.
    const order: string[] = [];
    const host = createRuntimeHost({
      environmentId,
      role: 'execution',
      sources: [
        {
          id: 'slow',
          start: ({ signal }) =>
            new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  order.push('cancel');
                  resolve();
                },
                { once: true },
              ),
            ),
          stop: async () => {
            order.push('release');
          },
        },
      ],
    });
    host.start();
    // When shutdown interrupts readiness.
    await host.stop();
    // Then pending startup cancels before release and cannot publish late readiness.
    expect(order).toEqual(['cancel', 'release']);
    expect(host.inspect().state).toBe('stopped');
    expect(host.inspect().sources[0]?.state).toBe('starting');
  });

  it('failure rejects execution sources on a manager-only host', () => {
    // Given a manager-only role.
    // When a native execution source is assigned.
    // Then construction rejects the role mismatch before startup.
    expect(() =>
      createRuntimeHost({
        environmentId,
        role: 'manager',
        sources: [
          {
            id: 'agent',
            start: async () => {},
            stop: async () => {},
          },
        ],
      }),
    ).toThrow();
  });
  it('serves hello while five independent sources start and subscribers detach', async () => {
    // Given five native sources, one blocked on readiness.
    const slow = gate();
    let stopped = 0;
    const host = createRuntimeHost({
      environmentId,
      role: 'local',
      sources: ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'].map((id) => ({
        id,
        start: () => (id === 'acp' ? slow.promise : Promise.resolve()),
        stop: async () => {
          stopped++;
        },
      })),
    });
    host.start();
    const first = host.connect('window-1');
    const second = host.connect('window-2');
    // When one observer disconnects while startup remains pending.
    first.disconnect();
    await Promise.resolve();
    // Then the host and its other observer remain available without stopping resources.
    expect(second.hello()).toMatchObject({ kind: 'hello', target: environmentId });
    expect(host.inspect().subscribers).toBe(1);
    expect(stopped).toBe(0);
    slow.resolve();
    await host.sourcesReady;
    expect(host.inspect().sources.map((source) => source.state)).toEqual(Array(5).fill('ready'));
    await host.stop();
    expect(stopped).toBe(5);
  });

  it('failure isolates startup errors from hello and sibling readiness', async () => {
    // Given a failing source alongside a working source.
    const host = createRuntimeHost({
      environmentId,
      role: 'execution',
      sources: [
        {
          id: 'broken',
          start: async () => {
            throw new Error('startup failure');
          },
          stop: async () => {},
        },
        { id: 'working', start: async () => {}, stop: async () => {} },
      ],
    });
    // When startup settles.
    host.start();
    await host.sourcesReady;
    // Then hello works and the failure stays local.
    expect(host.connect('ui').hello().kind).toBe('hello');
    expect(host.inspect().sources).toEqual([
      { id: 'broken', state: 'failed' },
      { id: 'working', state: 'ready' },
    ]);
    await host.stop();
  });

  it('failure fences stale generations without disconnecting their replacement', async () => {
    // Given two generations of the same observer.
    const host = createRuntimeHost({ environmentId, role: 'local' });
    host.start();
    const stale = host.connect('window');
    const fresh = host.connect('window');
    // When a late disconnect arrives from the old generation.
    stale.disconnect();
    // Then it cannot remove or mutate through the new generation.
    expect(host.inspect().subscribers).toBe(1);
    expect(() => stale.hello()).toThrow();
    expect(fresh.hello().generation).toBeGreaterThan(0);
    await host.stop();
  });

  it('failure closes admission, drains accepted work, releases owned resources despite stop failure', async () => {
    // Given an accepted operation and both owned and borrowed resources.
    const work = gate();
    const order: string[] = [];
    const host = createRuntimeHost({
      environmentId,
      role: 'local',
      sources: [
        {
          id: 'native',
          start: async () => {},
          stop: async () => {
            order.push('native');
            throw new Error('stop failure');
          },
        },
      ],
    });
    host.resources.register('borrowed', 'borrowed', async () => {
      order.push('borrowed');
    });
    host.resources.register('reverse', 'owned', async () => {
      order.push('reverse');
    });
    host.start();
    await host.sourcesReady;
    const accepted = host.mutate(async () => {
      await work.promise;
      order.push('mutation');
    });
    // When shutdown races the accepted operation.
    const stop = host.stop();
    const duplicate = host.stop();
    await expect(host.mutate(async () => {})).rejects.toMatchObject({ code: 'cancelled' });
    work.resolve();
    await accepted;
    // Then every owned resource releases after the drain and borrowed resources survive.
    await expect(stop).rejects.toBeInstanceOf(AggregateError);
    await expect(duplicate).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['mutation', 'native', 'reverse']);
  });
});

describe('runtime persistent identity', () => {
  it('retains one identity across concurrent initialization and restart', async () => {
    // Given an empty isolated state root.
    const root = await mkdtemp(path.join(tmpdir(), 'vis-runtime-identity-'));
    try {
      // When multiple hosts initialize the same target concurrently.
      const ids = await Promise.all(Array.from({ length: 8 }, () => loadEnvironmentIdentity(root)));
      // Then each host sees the one persisted target identity.
      expect(new Set(ids).size).toBe(1);
      expect(await loadEnvironmentIdentity(root)).toBe(ids[0]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('failure preserves corrupt identity bytes and refuses anonymous replacement', async () => {
    // Given existing corrupt identity state.
    const root = await mkdtemp(path.join(tmpdir(), 'vis-runtime-corrupt-'));
    await mkdir(path.join(root, 'runtime'));
    const file = path.join(root, 'runtime/environment.json');
    await writeFile(file, '{broken');
    try {
      // When initialization reads it.
      await expect(loadEnvironmentIdentity(root)).rejects.toBeInstanceOf(SyntaxError);
      // Then it preserves original bytes.
      expect(await readFile(file, 'utf8')).toBe('{broken');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('failure refuses a read-only identity directory', async () => {
    // Given a target state root without write permission.
    const root = await mkdtemp(path.join(tmpdir(), 'vis-runtime-readonly-'));
    await chmod(root, 0o500);
    try {
      // When initialization attempts to persist identity.
      // Then it reports failure rather than issuing an unstable ID.
      await expect(loadEnvironmentIdentity(root)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });
});
