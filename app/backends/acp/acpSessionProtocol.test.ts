import { beforeEach, describe, expect, it } from 'vitest';
import { AcpClient } from './acpClient';
import { MockAcpWebSocket, sent } from './acpTestHarness';
import { beginAcpPrompt, completeAcpPrompt, createAcpSessionState } from './history';
import { loadAcpSessionHistory } from './sessionHistory';

async function initialize(capabilities: Record<string, unknown>) {
  const client = new AcpClient({ url: 'ws://localhost/acp', agentId: 'test', webSocketCtor: MockAcpWebSocket });
  const initializing = client.initialize();
  const socket = MockAcpWebSocket.instances.at(-1);
  if (!socket) throw new Error('Missing socket');
  socket.open();
  await Promise.resolve();
  socket.receive({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: capabilities } } });
  await initializing;
  return { client, socket };
}

describe('ACP v1 session protocol', () => {
  beforeEach(() => { MockAcpWebSocket.instances = []; });

  it('preserves cached messages and turn numbering when resume does not replay history', async () => {
    const state = createAcpSessionState({ id: 's', directory: '/workspace' });
    beginAcpPrompt(state, [{ type: 'text', text: 'previous' }], 1, 'test');
    completeAcpPrompt(state, 'end_turn', 2);
    const sessions = new Map([['s', state]]);
    const requests: unknown[] = [];
    const entries = await loadAcpSessionHistory({ sessionId: 's', sessions, loadedSessions: new Set(), supports: (method) => method === 'session/resume', request: async (method, params) => { requests.push({ method, params }); return {}; } });
    expect(entries).toHaveLength(2);
    expect(sessions.get('s')?.turn).toBe(1);
    expect(requests).toEqual([{ method: 'session/resume', params: { sessionId: 's', cwd: '/workspace', mcpServers: [] } }]);
  });

  it('reads every session list page with its opaque cursor and cwd', async () => {
    const { client, socket } = await initialize({ list: {} });
    const listing = client.listSessions({ directory: '/workspace' });
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessions: [{ sessionId: 'one', cwd: '/workspace' }], nextCursor: 'opaque' } });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toMatchObject({ method: 'session/list', params: { cwd: '/workspace', cursor: 'opaque' } });
    socket.receive({ jsonrpc: '2.0', id: 3, result: { sessions: [{ sessionId: 'two', cwd: '/workspace' }] } });
    expect((await listing).map((session) => session.id)).toEqual(['one', 'two']);
    client.disconnect();
  });

  it('stops listing when an agent repeats a pagination cursor', async () => {
    const { client, socket } = await initialize({ list: {} });
    const listing = client.listSessions();
    const rejected = expect(listing).rejects.toThrow('pagination cursor');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessions: [], nextCursor: 'same' } });
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, result: { sessions: [], nextCursor: 'same' } });
    await rejected;
    expect(socket.sent).toHaveLength(3);
    client.disconnect();
  });

  it('keeps the session active when close fails', async () => {
    const { client, socket } = await initialize({ close: {} });
    const creating = client.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    await creating;
    const closing = client.closeSession('s');
    const rejected = expect(closing).rejects.toThrow('denied');
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, error: { code: -32000, message: 'denied' } });
    await rejected;
    expect(client.getSessionStatusMap()).toEqual({ s: { type: 'idle' } });
    expect(await client.listSessionMessages('s')).toEqual([]);
    expect(socket.sent).toHaveLength(3);
    client.disconnect();
  });

  it('rejects unsupported fork and close without sending requests', async () => {
    const { client, socket } = await initialize({});
    await expect(client.forkSession('s', '/workspace')).rejects.toThrow('session/fork');
    await expect(client.closeSession('s')).rejects.toThrow('session/close');
    expect(socket.sent).toHaveLength(1);
    client.disconnect();
  });

  it('forks using v1 parameters and closes without deleting persisted session history', async () => {
    const { client, socket } = await initialize({ fork: {}, close: {}, resume: {} });
    const forking = client.forkSession('source', '/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    expect(sent(socket, 1)).toMatchObject({ method: 'session/fork', params: { sessionId: 'source', cwd: '/workspace', mcpServers: [] } });
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 'fork', configOptions: [] } });
    expect(await forking).toMatchObject({ id: 'fork', directory: '/workspace' });
    const closing = client.closeSession('fork');
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sent(socket, 2)).toMatchObject({ method: 'session/close', params: { sessionId: 'fork' } });
    socket.receive({ jsonrpc: '2.0', id: 3, result: {} });
    await closing;
    expect(client.getSessionStatusMap()).toEqual({});
    expect((await client.listSessions()).map((session) => session.id)).toContain('fork');
    const loading = client.listSessionMessages('fork', '/workspace');
    await expect.poll(() => socket.sent.length).toBe(4);
    expect(sent(socket, 3)).toMatchObject({ method: 'session/resume' });
    socket.receive({ jsonrpc: '2.0', id: 4, result: {} });
    await loading;
    client.disconnect();
  });
});
