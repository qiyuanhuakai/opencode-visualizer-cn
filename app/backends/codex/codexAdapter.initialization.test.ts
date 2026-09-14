import { afterEach, describe, expect, it } from 'vitest';
import { createCodexAdapter } from './codexAdapter';
import {
  closeCodexTestSockets,
  CodexTestSocket as MockWebSocket,
  waitForSent,
} from './codexTestSocket';

describe('CodexAdapter', () => {
  afterEach(closeCodexTestSockets);

  it('initializes with client metadata and sends initialized notification', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
      clientInfo: { name: 'vis_test', title: 'Vis Test', version: '0.0.0' },
    });

    const initialized = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);

    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'vis_test', title: 'Vis Test', version: '0.0.0' },
        capabilities: { experimentalApi: false },
      },
    });

    const initializeResult = {
      userAgent: 'vis/0.145.0 (Linux 6.6; x86_64) codex_cli_rs/0.145.0 (vis_test; 0.0.0)',
    };
    socket.respond(1, initializeResult);
    await expect(initialized).resolves.toEqual(initializeResult);
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({ method: 'initialized', params: {} });
    await expect(adapter.getGlobalHealth()).resolves.toEqual({ healthy: true, version: '0.145.0' });
  });

  it('treats an already-initialized transport as initialized', async () => {
    MockWebSocket.instances = [];
    const adapter = createCodexAdapter({
      url: 'ws://localhost:4500',
      webSocketCtor: MockWebSocket,
    });

    const initialized = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.emitOpen();
    await waitForSent(socket, 1);
    socket.emitMessage(
      JSON.stringify({
        id: 1,
        error: { code: -32600, message: 'Already initialized' },
      }),
    );
    await expect(initialized).resolves.toEqual({});

    const list = adapter.listThreads({ limit: 1 });
    await waitForSent(socket, 2);
    socket.respond(2, { data: [], nextCursor: null });
    await expect(list).resolves.toEqual({ data: [], nextCursor: null });
  });

  it('advertises bridge-backed interactive PTY terminal support', () => {
    const adapter = createCodexAdapter({ url: 'ws://localhost:4500' });
    expect(adapter.capabilities.terminal).toBe(true);
    expect(adapter.createPtyWebSocketUrl('/pty/abc/connect', { directory: '/repo' })).toBe(
      'ws://localhost:4500/pty/abc/connect?directory=%2Frepo',
    );
  });
});
