import { describe, expect, it, vi } from 'vitest';
import { closeTrackedLocalFileSession } from './localFileSessionTracking';

describe('closeTrackedLocalFileSession', () => {
  it('retains the renderer target until close succeeds so cleanup can be retried', async () => {
    const targets = new Map([['session-1', { path: '/tmp/file' }]]);
    const close = vi
      .fn<(sessionId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValueOnce();

    await expect(closeTrackedLocalFileSession(targets, 'session-1', close)).rejects.toThrow(
      'cleanup failed',
    );
    expect(targets.has('session-1')).toBe(true);

    await closeTrackedLocalFileSession(targets, 'session-1', close);
    expect(targets.has('session-1')).toBe(false);
  });
});
