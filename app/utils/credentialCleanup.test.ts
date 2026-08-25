import { describe, expect, it, vi } from 'vitest';

import { createSingleFlightCredentialCleanup } from './credentialCleanup';

describe('createSingleFlightCredentialCleanup', () => {
  it('serializes concurrent unauthorized events behind one acknowledgement', async () => {
    // Given: the first deletion fails while its user confirmation remains pending.
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const disconnect = vi.fn();
    const clear = vi.fn().mockReturnValueOnce('failed').mockReturnValueOnce('cleared');
    const cleanup = createSingleFlightCredentialCleanup({
      disconnect,
      clear,
      confirmRetry: () => confirmation,
      runExclusive: async (operation) => operation(),
    });

    // When: two unauthorized events request cleanup before the user answers.
    const first = cleanup('revision-1');
    const second = cleanup('revision-1');

    // Then: the second event cannot perform an unacknowledged extra deletion attempt.
    expect(first).toBe(second);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();

    resolveConfirmation?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('does not retry deletion after replacement credentials are saved', async () => {
    // Given: deletion failed and its retry confirmation is pending.
    let storedCredential: string | null = 'old-secret';
    let mutationTail = Promise.resolve();
    let resolveConfirmation: ((value: boolean) => void) | undefined;
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirmation = resolve;
    });
    const runExclusive = <T>(operation: () => Promise<T> | T) => {
      const result = mutationTail.then(operation);
      mutationTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    const clear = vi
      .fn()
      .mockReturnValueOnce('failed')
      .mockImplementationOnce(() => {
        storedCredential = null;
        return 'cleared';
      });
    const cleanup = createSingleFlightCredentialCleanup({
      disconnect: vi.fn(),
      clear,
      confirmRetry: () => confirmation,
      runExclusive,
    });
    const pendingCleanup = cleanup('old-revision');
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());

    // When: replacement credentials are submitted while the old retry owns the mutation lock.
    const replacementSave = runExclusive(() => {
      storedCredential = 'replacement-secret';
    });
    resolveConfirmation?.(true);

    // Then: cleanup finishes first and the queued replacement remains durable.
    await expect(pendingCleanup).resolves.toBe(true);
    await replacementSave;
    expect(clear).toHaveBeenCalledTimes(2);
    expect(storedCredential).toBe('replacement-secret');
  });

  it('rejects cleanup owned by a superseded credential revision', async () => {
    // Given: a delayed 401 belongs to credentials replaced before cleanup acquires the lock.
    const clear = vi.fn((expectedRevision: string | null) =>
      expectedRevision === 'old-revision' ? 'stale' : 'cleared',
    );
    const disconnect = vi.fn();
    const cleanup = createSingleFlightCredentialCleanup({
      disconnect,
      clear,
      confirmRetry: async () => true,
      runExclusive: async (operation) => operation(),
    });

    // When: the delayed cleanup supplies its original connection revision.
    const result = await cleanup('old-revision');

    // Then: the revision reaches conditional clear and stale credentials are not deleted.
    expect(result).toBe(false);
    expect(clear).toHaveBeenCalledWith('old-revision');
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('settles a second window when the same revision was already cleared', async () => {
    // Given: another window already replaced the rejected revision with a logout tombstone.
    const disconnect = vi.fn();
    const confirmRetry = vi.fn(async () => true);
    const cleanup = createSingleFlightCredentialCleanup({
      disconnect,
      clear: () => 'already-cleared',
      confirmRetry,
      runExclusive: async (operation) => operation(),
    });

    // When: this window handles the same rejected revision after the first cleanup.
    const result = await cleanup('rejected-revision');

    // Then: logout completes locally without another delete attempt or failure prompt.
    expect(result).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(confirmRetry).not.toHaveBeenCalled();
  });
});
