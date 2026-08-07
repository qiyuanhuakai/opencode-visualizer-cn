import { describe, expect, it } from 'vitest';
import { createBackendRequestFence } from './backendRequestFence';
import type { BackendKind } from '../backends/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

describe('createBackendRequestFence', () => {
  it('rejects a late result from the backend that was replaced', async () => {
    let activeBackend: BackendKind = 'codex';
    const fence = createBackendRequestFence(() => activeBackend);
    const codex = deferred<string>();
    const codexRequest = fence.start();

    activeBackend = 'opencode';
    const openCodeRequest = fence.start();

    expect(fence.isCurrent(openCodeRequest)).toBe(true);
    codex.resolve('stale-codex-model');
    await codex.promise;
    expect(fence.isCurrent(codexRequest)).toBe(false);
  });

  it('rejects an original token after an ABA backend transition', () => {
    let activeBackend: BackendKind = 'codex';
    const fence = createBackendRequestFence(() => activeBackend);
    const originalCodexRequest = fence.start();

    activeBackend = 'opencode';
    fence.invalidate();
    activeBackend = 'codex';
    fence.invalidate();

    expect(fence.isCurrent(originalCodexRequest)).toBe(false);
  });
});
