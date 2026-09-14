import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexJsonRpcClient, CodexJsonRpcError } from './jsonRpcClient';
import { closeCodexTestSockets, CodexTestSocket as MockWebSocket } from './codexTestSocket';

describe('CodexJsonRpcClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    closeCodexTestSockets();
    vi.useRealTimers();
  });

  it('connects using the provided WebSocket constructor', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toBe('ws://localhost:4500');

    MockWebSocket.instances[0]?.emitOpen();
    await expect(connected).resolves.toBeUndefined();
    expect(client.isConnected()).toBe(true);
  });

  it('redacts bridge tokens from connection errors', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:23004/codex?token=secret-token&mode=test',
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    MockWebSocket.instances[0]?.emitError();

    await expect(connected).rejects.toThrow(
      'Codex WebSocket connection failed: ws://localhost:23004/codex?token=REDACTED&mode=test',
    );
  });

  it('sends requests and resolves matching responses', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const request = client.request('thread/list', { limit: 5 });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 1,
      method: 'thread/list',
      params: { limit: 5 },
    });

    socket.emitMessage(JSON.stringify({ id: 1, result: { data: [], nextCursor: null } }));
    await expect(request).resolves.toEqual({ data: [], nextCursor: null });
  });

  it('ignores malformed transport frames until a valid response arrives', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const request = client.request('thread/list');
    socket.emitMessage('{malformed json');
    socket.respond(1, { data: [], nextCursor: null });

    await expect(request).resolves.toEqual({ data: [], nextCursor: null });
  });

  it('rejects pending requests with the transport close reason', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const request = client.request('thread/list');
    socket.emitClose('bridge stopped', 1001);

    await expect(request).rejects.toThrow('Codex WebSocket closed: bridge stopped');
    expect(client.isConnected()).toBe(false);
  });

  it('forwards WebSocket protocols and reports close before opening', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      protocols: ['codex-json-rpc'],
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    expect(socket.protocols).toEqual(['codex-json-rpc']);
    socket.emitClose('handshake rejected', 1002);

    await expect(connected).rejects.toThrow(
      'Codex WebSocket closed before opening: handshake rejected',
    );
  });

  it('rejects JSON-RPC error responses', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const request = client.request('thread/list');
    socket.emitMessage(
      JSON.stringify({
        id: 1,
        error: { code: -32001, message: 'Server overloaded; retry later.' },
      }),
    );

    await expect(request).rejects.toMatchObject({
      name: 'CodexJsonRpcError',
      code: -32001,
    } satisfies Partial<CodexJsonRpcError>);
  });

  it('routes notifications to subscribers', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const handler = vi.fn();
    client.onNotification(handler);

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    socket.emitMessage(
      JSON.stringify({
        method: 'turn/started',
        params: { turn: { id: 'turn_1' } },
      }),
    );

    expect(handler).toHaveBeenCalledWith({
      method: 'turn/started',
      params: { turn: { id: 'turn_1' } },
    });
  });

  it('routes server requests separately from responses and can answer them', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });
    const requestHandler = vi.fn();
    const notificationHandler = vi.fn();
    client.onServerRequest(requestHandler);
    client.onNotification(notificationHandler);

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    socket.emitMessage(
      JSON.stringify({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: ['pnpm', 'test'] },
      }),
    );

    expect(requestHandler).toHaveBeenCalledWith({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: { command: ['pnpm', 'test'] },
    });
    expect(notificationHandler).not.toHaveBeenCalled();

    client.respond('approval-1', 'accept');
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 'approval-1',
      result: 'accept',
    });
  });

  it('sends notifications without ids', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    client.notify('initialized', {});
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      method: 'initialized',
      params: {},
    });
  });

  it('supports strict JSON-RPC 2.0 envelopes and error responses for ACP', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:23004/acp/oh-my-pi',
      jsonRpcVersion: '2.0',
      webSocketCtor: MockWebSocket,
    });
    const requestHandler = vi.fn();
    client.onServerRequest(requestHandler);

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const initialize = client.request('initialize', { protocolVersion: 1 });
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    });
    socket.emitMessage(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }));
    await initialize;

    socket.emitMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'fs-1',
        method: 'fs/read_text_file',
        params: { sessionId: 'session-1', path: '/tmp/file' },
      }),
    );
    expect(requestHandler).toHaveBeenCalledWith({
      id: 'fs-1',
      method: 'fs/read_text_file',
      params: { sessionId: 'session-1', path: '/tmp/file' },
    });

    client.respondError('fs-1', -32601, 'Method not found');
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 'fs-1',
      error: { code: -32601, message: 'Method not found' },
    });
  });

  it('times out unanswered requests', async () => {
    const client = new CodexJsonRpcClient({
      url: 'ws://localhost:4500',
      requestTimeoutMs: 100,
      webSocketCtor: MockWebSocket,
    });

    const connected = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await connected;

    const request = client.request('thread/list');
    const rejection = expect(request).rejects.toThrow(
      'Codex JSON-RPC request timed out: thread/list',
    );
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
  });
});
