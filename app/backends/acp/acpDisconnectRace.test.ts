import { beforeEach, describe, expect, it } from 'vitest';

import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';

describe('ACP disconnect races', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('does not restore stale session state when a history load fails after disconnect', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions();
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessions: [{ sessionId: 'loaded-session', cwd: '/workspace/project' }] },
    });
    await listing;
    const loading = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    await expect.poll(() => socket.sent.length).toBe(3);

    adapter.disconnect();

    await expect(loading).rejects.toThrow('WebSocket disconnected');
    await Promise.resolve();
    await expect(adapter.getSessionStatusMap()).resolves.toEqual({});
  });
});
