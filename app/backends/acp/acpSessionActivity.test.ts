import { beforeEach, describe, expect, it } from 'vitest';
import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';

describe('ACP session activity semantics', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('keeps listed history neutral until the session is activated in this run', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions({ directory: '/workspace' });
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessions: [{ sessionId: 'history-1', cwd: '/workspace' }] },
    });
    const sessions = await listing;

    expect(sessions[0]?.status).toBeUndefined();
    expect(await adapter.getSessionStatusMap()).toEqual({});

    const loading = adapter.listSessionMessages('history-1', { directory: '/workspace' });
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, result: { configOptions: [] } });
    await loading;

    expect(await adapter.getSessionStatusMap()).toEqual({ 'history-1': { type: 'idle' } });
  });
});
