import { describe, expect, it } from 'vitest';
import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket, sent } from './acpTestHarness';

async function initializeOmp() {
  MockAcpWebSocket.instances = [];
  const adapter = createAcpAdapter({
    url: 'ws://localhost:23004/acp/oh-my-pi',
    bridgeUrl: 'ws://localhost:23004',
    agentId: 'oh-my-pi',
    webSocketCtor: MockAcpWebSocket,
  });
  const initializing = adapter.initialize();
  await expect.poll(() => MockAcpWebSocket.instances.length).toBe(1);
  const socket = MockAcpWebSocket.instances[0];
  socket?.open();
  await expect.poll(() => socket?.sent.length).toBe(1);
  socket?.receive({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: 1,
      agentInfo: { name: 'oh-my-pi', version: '17.0.2' },
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
    },
  });
  await initializing;
  if (!socket) throw new Error('Missing mock ACP socket.');
  return { adapter, socket };
}

describe('Oh My Pi 17.0.2 session deletion', () => {
  it('uses the supported ACP /session delete command and verifies removal', async () => {
    const { adapter, socket } = await initializeOmp();
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.type));

    expect(adapter.capabilities.sessionDelete).toBe(true);
    const deleting = adapter.deleteSession('session-1', '/repo');

    await expect.poll(() => socket.sent.length).toBe(2);
    expect(sent(socket, 1)).toMatchObject({
      method: 'session/resume',
      params: { sessionId: 'session-1', cwd: '/repo', mcpServers: [] },
    });
    socket.receive({ jsonrpc: '2.0', id: 2, result: { configOptions: [] } });

    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toMatchObject({
      method: 'session/prompt',
      params: { sessionId: 'session-1', prompt: [{ type: 'text', text: '/session delete' }] },
    });
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });

    await expect.poll(() => socket.sent.length).toBe(4);
    expect(sent(socket, 3)).toMatchObject({ method: 'session/list', params: { cwd: '/repo' } });
    socket.receive({ jsonrpc: '2.0', id: 4, result: { sessions: [] } });

    await deleting;
    expect(events).toContain('session.deleted');
    const eventCountAfterDelete = events.length;
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'late delete output' },
        },
      },
    });
    expect(events).toHaveLength(eventCountAfterDelete);
  });

  it('fails instead of claiming success when OMP still lists the session', async () => {
    const { adapter, socket } = await initializeOmp();
    const deleting = adapter.deleteSession('session-1', '/repo');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { configOptions: [] } });
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await expect.poll(() => socket.sent.length).toBe(4);
    socket.receive({
      jsonrpc: '2.0',
      id: 4,
      result: { sessions: [{ sessionId: 'session-1', cwd: '/repo', title: 'Still here' }] },
    });

    await expect(deleting).rejects.toThrow('did not remove session');
  });
});
