import { ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGlobalEvents } from './useGlobalEvents';
import { SseConnectionError } from '../utils/sseConnection';

vi.mock('../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('useGlobalEvents fail-fast connection errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves the HTTP status on the rejected connection promise', async () => {
    // Given: the direct transport receives a forbidden response.
    vi.stubGlobal('SharedWorker', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        body: null,
        headers: new Headers(),
      }),
    );
    const events = useGlobalEvents({
      baseUrl: ref('http://localhost'),
      authHeader: ref('Bearer secret'),
    });

    // When: fail-fast startup awaits the transport.
    const result = await events.connect({ failFast: true }).catch((error: unknown) => error);

    // Then: the rejection carries structured status instead of message text.
    expect(result).toBeInstanceOf(SseConnectionError);
    if (!(result instanceof SseConnectionError)) {
      throw new Error('Expected a typed SSE connection failure.');
    }
    expect(result.statusCode).toBe(403);
    events.dispose();
  });
});
