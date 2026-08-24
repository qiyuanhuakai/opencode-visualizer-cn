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
    const clear = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const cleanup = createSingleFlightCredentialCleanup({
      disconnect,
      clear,
      confirmRetry: () => confirmation,
    });

    // When: two unauthorized events request cleanup before the user answers.
    const first = cleanup();
    const second = cleanup();

    // Then: the second event cannot perform an unacknowledged extra deletion attempt.
    expect(first).toBe(second);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();

    resolveConfirmation?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
