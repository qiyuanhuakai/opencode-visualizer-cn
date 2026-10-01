import { describe, expect, it } from 'vitest';
import { runOpenCodeSend } from './backendMessageSend.openCode';
import type { BackendMessageSendParams, SendPreflight } from './backendMessageSend.types';

describe('runOpenCodeSend fail-closed seam', () => {
  it('returns stale for a dsh preflight instead of using the OpenCode API', async () => {
    const preflight = { backend: 'dsh' } as SendPreflight;
    const params = {} as BackendMessageSendParams;
    const guard = { isCurrent: () => true };

    await expect(runOpenCodeSend(params, preflight, guard)).resolves.toEqual({ kind: 'stale' });
  });
});
