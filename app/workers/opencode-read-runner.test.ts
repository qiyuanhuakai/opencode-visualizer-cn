import { describe, expect, it } from 'vitest';

import { createOpencodeReadRunner, OpencodeReadAbortedError } from './opencode-read-runner';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe('createOpencodeReadRunner', () => {
  it('never exceeds 12 actual underlying reads after aborted callers restart', async () => {
    const state = { generation: 1 };
    const runner = createOpencodeReadRunner<typeof state>({
      isCurrent: (candidate) => candidate === state,
      getGeneration: (candidate) => candidate.generation,
      configure: () => {},
    });
    const gates: Array<Deferred<void>> = [];
    let activeUnderlying = 0;
    let peakUnderlying = 0;
    const task = () => {
      const gate = deferred<void>();
      gates.push(gate);
      activeUnderlying += 1;
      peakUnderlying = Math.max(peakUnderlying, activeUnderlying);
      return gate.promise.finally(() => {
        activeUnderlying -= 1;
      });
    };
    const firstBatch = Array.from({ length: 12 }, () => {
      const controller = new AbortController();
      const promise = runner(state, task, {
        cancelOnAbort: true,
        generation: 1,
        signal: controller.signal,
      });
      return { controller, promise };
    });
    await flushMicrotasks();
    expect(activeUnderlying).toBe(12);

    for (const { controller } of firstBatch) controller.abort();
    const aborted = await Promise.allSettled(firstBatch.map(({ promise }) => promise));
    expect(aborted.every(
      (result) => result.status === 'rejected' && result.reason instanceof OpencodeReadAbortedError,
    )).toBe(true);
    expect(activeUnderlying).toBe(12);

    const secondBatch = Array.from({ length: 12 }, () => runner(state, task, {
      cancelOnAbort: true,
      generation: 1,
      signal: new AbortController().signal,
    }));
    await flushMicrotasks();

    expect(peakUnderlying).toBeLessThanOrEqual(12);
    expect(activeUnderlying).toBe(12);
    expect(gates).toHaveLength(12);

    for (const gate of gates.slice(0, 12)) gate.resolve();
    await flushMicrotasks();
    expect(gates).toHaveLength(24);
    expect(peakUnderlying).toBeLessThanOrEqual(12);
    expect(activeUnderlying).toBe(12);

    for (const gate of gates.slice(12)) gate.resolve();
    await Promise.all(secondBatch);
    expect(activeUnderlying).toBe(0);
  });
});
