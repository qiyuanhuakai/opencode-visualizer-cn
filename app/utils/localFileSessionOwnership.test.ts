import { describe, expect, it, vi } from 'vitest';
import { closeOwnedLocalFileSession } from '../../electron/localFileSessionOwnership.js';

describe('closeOwnedLocalFileSession', () => {
  it('retains ownership until cleanup succeeds so the same renderer can retry', async () => {
    const owners = new Map([['session-1', 42]]);
    const close = vi
      .fn<(sessionId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce();

    await expect(closeOwnedLocalFileSession(owners, { close }, 42, 'session-1')).rejects.toThrow(
      'cleanup failed',
    );
    expect(owners.get('session-1')).toBe(42);

    await expect(closeOwnedLocalFileSession(owners, { close }, 42, 'session-1')).resolves.toBe(true);
    expect(owners.has('session-1')).toBe(false);
  });

  it('does not close a session owned by another renderer', async () => {
    const owners = new Map([['session-1', 42]]);
    const close = vi.fn<(sessionId: string) => Promise<void>>();

    await expect(closeOwnedLocalFileSession(owners, { close }, 7, 'session-1')).resolves.toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(owners.get('session-1')).toBe(42);
  });
});
