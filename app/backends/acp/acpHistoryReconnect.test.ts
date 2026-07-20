import { beforeEach, describe, expect, it } from 'vitest';

import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';

function replayOneMessage(socket: MockAcpWebSocket, requestId: number) {
  socket.receive({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'loaded-session',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'user-wire',
        content: { type: 'text', text: 'Earlier question' },
      },
    },
  });
  socket.receive({ jsonrpc: '2.0', id: requestId, result: {} });
}

describe('ACP history reconnect', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('replaces replayed history instead of appending duplicates after reconnect', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions({ directory: '/workspace/project' });
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessions: [{ sessionId: 'loaded-session', cwd: '/workspace/project' }] },
    });
    await listing;

    const firstLoad = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    replayOneMessage(socket, 3);
    await expect(firstLoad).resolves.toHaveLength(1);

    socket.close();
    const reconnecting = adapter.initialize();
    const replacement = MockAcpWebSocket.instances[1];
    if (!replacement) throw new Error('Expected replacement ACP WebSocket instance.');
    replacement.open();
    await Promise.resolve();
    replacement.receive({
      jsonrpc: '2.0',
      id: 4,
      result: {
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
        agentInfo: { name: 'oh-my-pi', version: '14.9.2' },
      },
    });
    await reconnecting;

    const secondLoad = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    await expect.poll(() => replacement.sent.length).toBe(2);
    replayOneMessage(replacement, 5);

    await expect(secondLoad).resolves.toHaveLength(1);
  });
});
