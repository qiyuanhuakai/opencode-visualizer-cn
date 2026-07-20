import { beforeEach, describe, expect, it } from 'vitest';

import { initializeAdapter, MockAcpWebSocket, sent } from './acpTestHarness';

describe('AcpAdapter connection lifecycle', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('reinitializes after an unexpected WebSocket close', async () => {
    const { adapter, socket } = await initializeAdapter();
    socket.close();

    const reconnecting = adapter.initialize();
    expect(MockAcpWebSocket.instances).toHaveLength(2);
    const replacement = MockAcpWebSocket.instances[1];
    if (!replacement) throw new Error('Expected replacement ACP WebSocket instance.');
    replacement.open();
    await Promise.resolve();
    replacement.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: {} },
        agentInfo: { name: 'oh-my-pi', title: 'Oh My Pi', version: '14.9.2' },
      },
    });

    await expect(reconnecting).resolves.toEqual(expect.objectContaining({ protocolVersion: 1 }));
  });

  it('clears pending permissions when disconnected', async () => {
    const { adapter, socket } = await initializeAdapter();
    socket.receive({
      jsonrpc: '2.0',
      id: 77,
      method: 'session/request_permission',
      params: {
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'Run tests', kind: 'execute' },
        options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
      },
    });

    adapter.disconnect();

    await expect(adapter.listPendingPermissions()).resolves.toEqual([]);
  });

  it('uses config options returned by session/load for the active session', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions({ directory: '/workspace/project' });
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
    socket.receive({
      jsonrpc: '2.0',
      id: 3,
      result: {
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'provider/loaded',
            options: [{ value: 'provider/loaded', name: 'Loaded model' }],
          },
        ],
      },
    });
    await loading;
    const creating = adapter.createSession('/workspace/other');
    await expect.poll(() => socket.sent.length).toBe(4);
    socket.receive({
      jsonrpc: '2.0',
      id: 4,
      result: {
        sessionId: 'other-session',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'provider/other',
            options: [{ value: 'provider/other', name: 'Other model' }],
          },
        ],
      },
    });
    await creating;

    await adapter.listSessionMessages('loaded-session', { directory: '/workspace/project' });

    await expect(adapter.listProviders()).resolves.toEqual(
      expect.objectContaining({
        default: { acp: 'provider/loaded' },
      }),
    );
  });

  it('rejects a concurrent prompt for the same session', async () => {
    const { adapter, socket } = await initializeAdapter();
    const creating = adapter.createSession('/workspace/project');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'session-1', configOptions: [] },
    });
    await creating;
    const payload = {
      directory: '/workspace/project',
      agent: 'default',
      model: { providerID: 'acp', modelID: 'provider/model-a' },
      parts: [{ type: 'text' as const, text: 'Hello' }],
    };
    const first = adapter.sendPromptAsync('session-1', payload);
    await expect.poll(() => socket.sent.length).toBe(3);
    const second = adapter.sendPromptAsync('session-1', payload);
    await Promise.resolve();
    const sentCount = socket.sent.length;
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    if (sentCount > 3)
      socket.receive({ jsonrpc: '2.0', id: 4, result: { stopReason: 'end_turn' } });
    const results = await Promise.allSettled([first, second]);

    expect(sentCount).toBe(3);
    expect(sent(socket, 2)).toEqual(expect.objectContaining({ method: 'session/prompt' }));
    expect(results[1]).toEqual(expect.objectContaining({ status: 'rejected' }));
  });

  it('replays optional session/load updates into shared history', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions({ directory: '/workspace/project' });
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessions: [{ sessionId: 'loaded-session', cwd: '/workspace/project', title: 'Loaded' }],
        nextCursor: null,
      },
    });
    await expect(listing).resolves.toEqual([
      expect.objectContaining({ id: 'loaded-session', projectID: 'acp' }),
    ]);
    const loading = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toEqual({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/load',
      params: { sessionId: 'loaded-session', cwd: '/workspace/project', mcpServers: [] },
    });
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
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'loaded-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'assistant-wire',
          content: { type: 'text', text: 'Earlier answer' },
        },
      },
    });
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'loaded-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'different-id-per-chunk',
          content: { type: 'text', text: ' continued' },
        },
      },
    });
    socket.receive({ jsonrpc: '2.0', id: 3, result: {} });

    await expect(loading).resolves.toEqual([
      expect.objectContaining({ parts: [expect.objectContaining({ text: 'Earlier question' })] }),
      expect.objectContaining({
        parts: [expect.objectContaining({ text: 'Earlier answer continued' })],
      }),
    ]);
  });

  it('shares one in-flight history load for concurrent requests to the same session', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listing = adapter.listSessions();
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessions: [{ sessionId: 'loaded-session', cwd: '/workspace/project' }] },
    });
    await listing;

    const first = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    const second = adapter.listSessionMessages('loaded-session', {
      directory: '/workspace/project',
    });
    await expect.poll(() => socket.sent.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    const requestCount = socket.sent.length;
    socket.receive({ jsonrpc: '2.0', id: 3, result: { configOptions: [] } });
    if (requestCount > 3) {
      socket.receive({ jsonrpc: '2.0', id: 4, result: { configOptions: [] } });
    }

    await Promise.all([first, second]);
    expect(requestCount).toBe(3);
  });
});
