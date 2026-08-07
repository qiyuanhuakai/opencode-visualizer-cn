import { describe, expect, it, vi } from 'vitest';
import { retryReferencedSessionIds } from './retryReferencedSessions';

describe('retryReferencedSessionIds', () => {
  it('retries a partial response until every referenced child resolves', async () => {
    const load = vi.fn().mockResolvedValueOnce(['child-a']).mockResolvedValueOnce([
      'child-a',
      'child-b',
    ]);

    await expect(
      retryReferencedSessionIds(['child-a', 'child-b'], load, { wait: async () => {} }),
    ).resolves.toEqual(['child-a', 'child-b']);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('returns no authoritative result after bounded retries remain incomplete', async () => {
    const load = vi.fn().mockResolvedValue(['child-a']);

    await expect(
      retryReferencedSessionIds(['child-a', 'child-b'], load, {
        maxRetries: 3,
        wait: async () => {},
      }),
    ).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(4);
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
});
