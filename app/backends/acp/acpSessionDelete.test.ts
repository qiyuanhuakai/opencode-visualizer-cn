import { describe, expect, it } from 'vitest';
import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket, sent } from './acpTestHarness';

describe('ACP session delete capability', () => {
  it('enables and executes session/delete only when the agent advertises it', async () => {
    MockAcpWebSocket.instances = [];
    const adapter = createAcpAdapter({
      url: 'ws://localhost:23004/acp/agent',
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'agent',
      webSocketCtor: MockAcpWebSocket,
    });
    const events: string[] = [];
    adapter.onEvent((event) => events.push(event.type));
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
        agentCapabilities: { sessionCapabilities: { delete: {}, list: {} } },
      },
    });
    await initializing;

    expect(adapter.capabilities.sessionDelete).toBe(true);
    const deleting = adapter.deleteSession('session-1');
    await expect.poll(() => socket?.sent.length).toBe(2);
    expect(socket && sent(socket, 1)).toMatchObject({
      method: 'session/delete',
      params: { sessionId: 'session-1' },
    });
    socket?.receive({ jsonrpc: '2.0', id: 2, result: {} });
    await deleting;
    expect(events).toContain('session.deleted');
  });

  it('keeps delete disabled when the capability is absent', async () => {
    MockAcpWebSocket.instances = [];
    const adapter = createAcpAdapter({
      url: 'ws://localhost:23004/acp/agent',
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'agent',
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
      result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: {} } },
    });
    await initializing;

    expect(adapter.capabilities.sessionDelete).toBe(false);
    await expect(adapter.deleteSession('session-1')).rejects.toThrow('session/delete');
  });
});
