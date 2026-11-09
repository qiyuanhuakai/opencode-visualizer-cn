import { describe, expect, it } from 'vitest';
import { createRuntimeHost } from '../bridge/runtime/runtimeHost.js';

const environmentId = '11111111-1111-4111-8111-111111111111';

describe('runtime resource shutdown recovery', () => {
  it.each(['sync', 'async'] as const)('retries only failed %s releases without reopening admission or stopping borrowed resources', async kind => {
    const calls = { native: 0, released: 0, borrowed: 0 };
    const nativeStop = () => {
      calls.native++;
      if (calls.native === 1) throw new Error('recoverable stop failure');
    };
    const host = createRuntimeHost({
      environmentId, role: 'local',
      sources: [{ id: 'native', start: async () => {}, stop: kind === 'sync' ? nativeStop : async () => nativeStop() }],
    });
    host.resources.register('released', 'owned', async () => { calls.released++; });
    host.resources.register('borrowed', 'borrowed', async () => { calls.borrowed++; });
    host.start();
    await host.sourcesReady;
    const first = host.stop();
    expect(host.stop()).toBe(first);
    await expect(first).rejects.toBeInstanceOf(AggregateError);
    expect(() => host.resources.register('late', 'owned', async () => {})).toThrow(
      expect.objectContaining({ code: 'cancelled', field: 'resources.closed' }),
    );
    await expect(host.stop()).resolves.toBeUndefined();
    await expect(host.stop()).resolves.toBeUndefined();
    expect(calls).toEqual({ native: 2, released: 1, borrowed: 0 });
    await expect(host.mutate(async () => {})).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('closes resource admission before calling a release callback', async () => {
    const host = createRuntimeHost({ environmentId, role: 'local' });
    let releases = 0;
    host.resources.register('owned', 'owned', async () => {
      releases++;
      expect(() => host.resources.register('reentrant', 'owned', async () => {})).toThrow(
        expect.objectContaining({ code: 'cancelled', field: 'resources.closed' }),
      );
    });
    host.start();
    await expect(host.stop()).resolves.toBeUndefined();
    expect(releases).toBe(1);
  });
});

