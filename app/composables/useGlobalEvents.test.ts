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

type EpochTaggedWorkerMessage = WorkerToTabMessage & { readonly connectionEpoch: number };

function requireSharedWorkerPort(): SharedWorkerPortHarness {
  const port = sharedWorkerHarness.ports[0];
  if (!port) throw new Error('Expected the SharedWorker port.');
  return port;
}

function requireConnectMessage(
  message: TabToWorkerMessage | undefined,
  description: string,
): Extract<TabToWorkerMessage, { type: 'connect' }> {
  if (!message || message.type !== 'connect') {
    throw new Error(`Expected the ${description} SharedWorker connection.`);
  }
  return message;
}

function deliverWorkerMessages(
  port: SharedWorkerPortHarness,
  messages: readonly WorkerToTabMessage[],
): void {
  for (const message of messages) {
    port.onmessage?.(new MessageEvent('message', { data: message }));
  }
}

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
      backendKind: ref('opencode' as const),
      baseUrl: ref('http://localhost'),
      authHeader: ref('Bearer secret'),
      credentialRevision: ref(null),
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
    const events = useGlobalEvents({
      backendKind: ref('opencode' as const),
      baseUrl,
      authHeader,
      credentialRevision: ref(null),
    });
    const errors: Array<{
      message: string;
      statusCode?: number;
      credentialRevision: string | null;
    }> = [];
    events.on('connection.error', (error) => errors.push(error));
    const firstConnection = events.connect({ failFast: true });
    const port = sharedWorkerHarness.ports[0];
    if (!port) throw new Error('Expected the SharedWorker port.');
    const firstConnect = port.sent[0];
    const firstEpoch =
      firstConnect && 'connectionEpoch' in firstConnect ? Number(firstConnect.connectionEpoch) : 1;
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
          credentialRevision: null,
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

  it('drops every queued message owned by the superseded SharedWorker connection', async () => {
    // Given: connection A is open and the renderer has already requested replacement B.
    vi.stubGlobal('SharedWorker', class {});
    const credentialRevision = ref<string | null>('revision-a');
    const events = useGlobalEvents({
      backendKind: ref('opencode' as const),
      baseUrl: ref('http://shared'),
      authHeader: ref<string | undefined>('Bearer shared'),
      credentialRevision,
    });
    const packets = vi.fn();
    const workerMessages = vi.fn(() => false);
    events.on('session.updated', packets);
    events.setWorkerMessageHandler(workerMessages);
    const firstConnection = events.connect({ failFast: true });
    const port = requireSharedWorkerPort();
    const firstConnect = requireConnectMessage(port.sent[0], 'initial');
    port.onmessage?.(
      new MessageEvent('message', {
        data: {
          type: 'connection.open',
          connectionEpoch: firstConnect.connectionEpoch,
        } as WorkerToTabMessage,
      }),
    );
    await firstConnection;
    credentialRevision.value = 'revision-b';
    await nextTick();
    const replacementConnect = requireConnectMessage(port.sent.at(-1), 'replacement');
    workerMessages.mockClear();
    packets.mockClear();

    // When: A's queued packet, state, and notification arrive after B owns the tab.
    const staleMessages = [
      {
        type: 'packet',
        connectionEpoch: firstConnect.connectionEpoch,
        packet: {
          directory: '/repo',
          payload: { type: 'session.updated', properties: { info: { id: 'stale' } } },
        },
      },
      {
        type: 'state.bootstrap',
        connectionEpoch: firstConnect.connectionEpoch,
        projects: {},
        notifications: {},
      },
      {
        type: 'notification.show',
        connectionEpoch: firstConnect.connectionEpoch,
        projectId: 'project-a',
        sessionId: 'session-a',
        kind: 'idle',
      },
    ] satisfies EpochTaggedWorkerMessage[];
    deliverWorkerMessages(port, staleMessages);

    // Then: no stale connection-owned message reaches either renderer ingress.
    expect(workerMessages).not.toHaveBeenCalled();
    expect(packets).not.toHaveBeenCalled();

    const currentPacket = {
      ...staleMessages[0],
      connectionEpoch: replacementConnect.connectionEpoch,
    } satisfies EpochTaggedWorkerMessage;
    port.onmessage?.(new MessageEvent('message', { data: currentPacket }));
    expect(workerMessages).toHaveBeenCalledTimes(1);
    expect(packets).toHaveBeenCalledTimes(1);
    events.dispose();
  });

  it('binds lifecycle errors to the credential revision that opened the transport', async () => {
    // Given: a SharedWorker transport is connected with one credential revision.
    vi.stubGlobal('SharedWorker', class {});
    const credentialRevision = ref<string | null>('revision-a');
    const events = useGlobalEvents({
      backendKind: ref('opencode' as const),
      baseUrl: ref('http://shared'),
      authHeader: ref<string | undefined>('Bearer shared'),
      credentialRevision,
    });
    const errors: Array<{ credentialRevision: string | null }> = [];
    events.on('connection.error', (error) => errors.push(error));
    const firstConnection = events.connect({ failFast: true });
    const port = sharedWorkerHarness.ports[0];
    if (!port) throw new Error('Expected the SharedWorker port.');
    const firstConnect = port.sent[0];
    const firstEpoch =
      firstConnect && 'connectionEpoch' in firstConnect ? firstConnect.connectionEpoch : 1;
    port.onmessage?.(
      new MessageEvent('message', {
        data: { type: 'connection.open', connectionEpoch: firstEpoch } as WorkerToTabMessage,
      }),
    );
    await firstConnection;

    // When: same-value replacement credentials advance only the durable revision.
    credentialRevision.value = 'revision-b';
    await nextTick();
    const replacementConnect = port.sent.at(-1);

    // Then: a replacement transport is opened and its 401 names revision B.
    expect(replacementConnect).toMatchObject({
      type: 'connect',
      credentialRevision: 'revision-b',
    });
    if (!replacementConnect || !('connectionEpoch' in replacementConnect)) {
      throw new Error('Expected a replacement connection.');
    }
    port.onmessage?.(
      new MessageEvent('message', {
        data: {
          type: 'connection.error',
          connectionEpoch: replacementConnect.connectionEpoch,
          credentialRevision: 'revision-b',
          message: 'Replacement rejected credentials',
          statusCode: 401,
        } as WorkerToTabMessage,
      }),
    );
    expect(errors).toEqual([
      {
        message: 'Replacement rejected credentials',
        statusCode: 401,
        credentialRevision: 'revision-b',
      },
    ]);
    events.dispose();
  });

  it('aborts the physical direct request before rebinding a replacement revision', async () => {
    // Given: direct request A is still awaiting its HTTP response.
    vi.stubGlobal('SharedWorker', undefined);
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const credentialRevision = ref<string | null>('revision-a');
    const events = useGlobalEvents({
      backendKind: ref('opencode' as const),
      baseUrl: ref('http://shared'),
      authHeader: ref<string | undefined>('Bearer shared'),
      credentialRevision,
    });
    const errors: Array<{ credentialRevision: string | null }> = [];
    events.on('connection.error', (error) => errors.push(error));
    await events.connect();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // When: replacement revision B starts before A returns a delayed 401.
    credentialRevision.value = 'revision-b';
    await nextTick();

    // Then: B owns a new request and A's response cannot emit a B-labelled error.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    responses[0]?.(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(errors).toEqual([]);
    responses[1]?.(new Response(null, { status: 401 }));
    await vi.waitFor(() =>
      expect(errors).toEqual([expect.objectContaining({ credentialRevision: 'revision-b' })]),
    );
    events.dispose();
  });

  it('disconnects OpenCode before publishing another backend revision', async () => {
    // Given: direct OpenCode request A is pending under revision A.
    vi.stubGlobal('SharedWorker', undefined);
    const responses: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Promise<Response>((resolve) => responses.push(resolve)),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backendKind = ref<'opencode' | 'codex'>('opencode');
    const credentialRevision = ref<string | null>('revision-a');
    const events = useGlobalEvents({
      backendKind,
      baseUrl: ref('http://shared'),
      authHeader: ref<string | undefined>('Bearer open-code-a'),
      credentialRevision,
    });
    const errors: Array<{ credentialRevision: string | null }> = [];
    events.on('connection.error', (error) => errors.push(error));
    await events.connect();
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;

    // When: another window atomically commits Codex revision B.
    backendKind.value = 'codex';
    credentialRevision.value = 'revision-b';
    await nextTick();

    // Then: A is aborted and no OpenCode request can carry the Codex revision.
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    responses[0]?.(new Response(null, { status: 401 }));
    await Promise.resolve();
    expect(errors).toEqual([]);
    events.dispose();
  });
});
