import { describe, expect, it, vi } from 'vitest';
import { requestWorkerResult, retryReferencedSessionIds } from './retryReferencedSessions';

describe('retryReferencedSessionIds', () => {
  it('falls back immediately when the worker transport cannot send', async () => {
    const unregister = vi.fn();
    const result = await requestWorkerResult<string[]>({
      register: () => unregister,
      send: () => false,
      timeoutMs: 30_000,
    });

    expect(result).toBeUndefined();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('falls back and unregisters when a posted worker reply is lost', async () => {
    vi.useFakeTimers();
    const unregister = vi.fn();
    try {
      const resultPromise = requestWorkerResult<string[]>({
        register: () => unregister,
        send: () => true,
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);

      await expect(resultPromise).resolves.toBeUndefined();
      expect(unregister).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns undefined without retrying when worker hydration is unavailable', async () => {
    const load = vi.fn<() => Promise<string[] | undefined>>().mockResolvedValue(undefined);

    const result = await retryReferencedSessionIds(['child-a', 'child-b'], load);

    expect(result).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('retries a partial response until every referenced child resolves', async () => {
    const load = vi.fn().mockResolvedValueOnce(['child-a']).mockResolvedValueOnce([
      'child-a',
      'child-b',
    ]);

    await expect(
      retryReferencedSessionIds(['child-a', 'child-b'], load, { wait: async () => {} }),
    ).resolves.toEqual(['child-a', 'child-b']);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenNthCalledWith(1, ['child-a', 'child-b']);
    expect(load).toHaveBeenNthCalledWith(2, ['child-b']);
  });

  it('returns accumulated successes after bounded retries remain incomplete', async () => {
    const load = vi.fn().mockResolvedValue(['child-a']);

    await expect(
      retryReferencedSessionIds(['child-a', 'child-b'], load, {
        maxRetries: 3,
        wait: async () => {},
      }),
    ).resolves.toEqual(['child-a']);
    expect(load).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenNthCalledWith(2, ['child-b']);
  });

  it('stops before a delayed retry after its continuation becomes stale', async () => {
    let current = true;
    const load = vi.fn().mockResolvedValue(['child-a']);

    await expect(
      retryReferencedSessionIds(['child-a', 'child-b'], load, {
        shouldContinue: () => current,
        wait: async () => {
          current = false;
        },
      }),
    ).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('partitions 129 referenced sessions into bounded requests without losing the last child', async () => {
    const sessionIds = Array.from({ length: 129 }, (_, index) => `child-${index + 1}`);
    const load = vi.fn((batch: string[]) => Promise.resolve(batch));

    await expect(
      retryReferencedSessionIds(sessionIds, load, {
        maxBatchSize: 128,
        wait: async () => {},
      }),
    ).resolves.toEqual(sessionIds);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load.mock.calls.map(([batch]) => batch.length)).toEqual([128, 1]);
  });
});
