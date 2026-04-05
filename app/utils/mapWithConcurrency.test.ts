import { describe, expect, it, vi } from 'vitest';

import { mapWithConcurrency } from './mapWithConcurrency';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('mapWithConcurrency', () => {
  it('respects the concurrency limit while preserving result order', async () => {
    const deferred = [createDeferred<number>(), createDeferred<number>(), createDeferred<number>()];
    const active: number[] = [];
    let running = 0;
    let maxRunning = 0;

    const task = mapWithConcurrency([0, 1, 2], 2, async (item) => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      active.push(item);
      const value = await deferred[item].promise;
      running -= 1;
      return value;
    });

    await Promise.resolve();

    expect(active).toEqual([0, 1]);
    expect(maxRunning).toBe(2);

    deferred[0].resolve(10);
    await vi.waitFor(() => {
      expect(active).toEqual([0, 1, 2]);
    });

    deferred[1].resolve(20);
    deferred[2].resolve(30);

    await expect(task).resolves.toEqual([
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
      { status: 'fulfilled', value: 30 },
    ]);
  });

  it('captures per-item failures without aborting the rest of the batch', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 3, async (item) => {
      if (item === 2) throw new Error('boom');
      return item * 2;
    });

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
    expect(results[1]?.status).toBe('rejected');
    if (results[1]?.status === 'rejected') {
      expect(results[1].reason).toBeInstanceOf(Error);
      expect((results[1].reason as Error).message).toBe('boom');
    }
  });
});
