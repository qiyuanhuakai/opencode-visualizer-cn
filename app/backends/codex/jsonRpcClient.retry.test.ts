import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexJsonRpcClient } from './jsonRpcClient';

type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(event: { reason?: string }) => void>;
};

class RetryWebSocket {
  static instances: RetryWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: ListenerMap = { open: [], message: [], error: [], close: [] };

  constructor(readonly url: string, readonly protocols?: string | string[]) {
    RetryWebSocket.instances.push(this);
  }

  addEventListener<T extends keyof ListenerMap>(type: T, listener: ListenerMap[T][number]) {
    this.listeners[type].push(listener as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({});
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  respond(payload: unknown) {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(payload) });
  }
}

async function connectedClient() {
  const client = new CodexJsonRpcClient({
    url: 'ws://127.0.0.1:4500',
    webSocketCtor: RetryWebSocket,
  });
  const connection = client.connect();
  const socket = RetryWebSocket.instances[0]!;
  socket.open();
  await connection;
  return { client, socket };
}

describe('CodexJsonRpcClient overload retry', () => {
  beforeEach(() => {
    RetryWebSocket.instances = [];
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries -32001 only when the caller explicitly opts in', async () => {
    const { client, socket } = await connectedClient();
    const request = client.request<{ ok: boolean }>('thread/list', {}, {
      retryOverloaded: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    });

    socket.respond({
      id: 1,
      error: { code: -32001, message: 'Server overloaded', data: { retryAfterMs: 250 } },
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(socket.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent).toHaveLength(2);
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({ id: 2, method: 'thread/list' });

    socket.respond({ id: 2, result: { ok: true } });
    await expect(request).resolves.toEqual({ ok: true });
  });

  it('does not send a retry into a replacement connection', async () => {
    const { client, socket } = await connectedClient();
    const request = client.request('thread/list', {}, {
      retryOverloaded: { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 100 },
    });
    const requestError = request.then(
      () => undefined,
      (error: unknown) => error,
    );
    socket.respond({ id: 1, error: { code: -32001, message: 'Server overloaded' } });
    client.disconnect();

    const reconnect = client.connect();
    const replacement = RetryWebSocket.instances[1]!;
    replacement.open();
    await reconnect;
    await vi.advanceTimersByTimeAsync(100);

    const error = await requestError;
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error('Expected retry cancellation error.');
    expect(error.message).toContain('connection changed before retry');
    expect(replacement.sent).toHaveLength(0);
  });
});
