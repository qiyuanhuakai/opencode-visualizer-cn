import { nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGlobalEvents } from './useGlobalEvents';
import { SseConnectionError } from '../utils/sseConnection';
import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';

type SharedWorkerPortHarness = {
  onmessage: ((event: MessageEvent<WorkerToTabMessage>) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  sent: TabToWorkerMessage[];
};

const sharedWorkerHarness = vi.hoisted(() => ({ ports: [] as SharedWorkerPortHarness[] }));

vi.mock('../workers/sse-shared-worker?sharedworker', () => ({
  default: class FakeSseSharedWorker {
    readonly port: SharedWorkerPortHarness;

    constructor() {
      const sent: TabToWorkerMessage[] = [];
      this.port = {
        onmessage: null,
        postMessage: vi.fn((message: TabToWorkerMessage) => sent.push(message)),
        start: vi.fn(),
        sent,
      };
      sharedWorkerHarness.ports.push(this.port);
    }
  },
}));

vi.mock('../i18n/useI18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('useGlobalEvents fail-fast connection errors', () => {
  afterEach(() => {
    sharedWorkerHarness.ports.length = 0;
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

  it('drops a queued lifecycle error from the superseded SharedWorker connection', async () => {
    // Given: connection A is open and the renderer has already requested replacement B.
    vi.stubGlobal('SharedWorker', class {});
    const baseUrl = ref('http://a');
    const authHeader = ref<string | undefined>('Bearer a');
    const events = useGlobalEvents({ baseUrl, authHeader });
    const errors: Array<{ message: string; statusCode?: number }> = [];
    events.on('connection.error', (error) => errors.push(error));
    const firstConnection = events.connect({ failFast: true });
    const port = sharedWorkerHarness.ports[0];
    if (!port) throw new Error('Expected the SharedWorker port.');
    const firstConnect = port.sent[0];
    const firstEpoch =
      firstConnect && 'connectionEpoch' in firstConnect
        ? Number(firstConnect.connectionEpoch)
        : 1;
    port.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'connection.open', connectionEpoch: firstEpoch } as WorkerToTabMessage,
      }),
    );
    await firstConnection;

    baseUrl.value = 'http://b';
    authHeader.value = 'Bearer b';
    await nextTick();
    const secondConnect = port.sent.at(-1);
    const secondEpoch =
      secondConnect && 'connectionEpoch' in secondConnect
        ? Number(secondConnect.connectionEpoch)
        : 2;
    expect(secondEpoch).not.toBe(firstEpoch);

    // When: the browser delivers A's already-queued 401 after connect(B) was posted.
    port.onmessage?.(
      new MessageEvent('message', {
        data: {
          type: 'connection.error',
          connectionEpoch: firstEpoch,
          message: 'A rejected credentials',
          statusCode: 401,
        } as WorkerToTabMessage,
      }),
    );

    // Then: no public unauthorized event is emitted for B's current lifecycle.
    expect(errors).toEqual([]);
    port.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'connection.open', connectionEpoch: secondEpoch } as WorkerToTabMessage,
      }),
    );
    events.dispose();
  });
});
