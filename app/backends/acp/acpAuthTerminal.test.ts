import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket, sent } from './acpTestHarness';

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ACP terminal authentication', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it('advertises terminal auth and opens the managed agent command in a bridge PTY', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse([{ id: 'oh-my-pi', command: 'omp' }]))
      .mockResolvedValueOnce(
        jsonResponse({ id: 'pty-auth', title: 'Set up Oh My Pi in terminal' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAcpAdapter({
      url: 'ws://bridge.test/acp/oh-my-pi',
      bridgeUrl: 'ws://bridge.test',
      agentId: 'oh-my-pi',
      webSocketCtor: MockAcpWebSocket,
    });
    const initializing = adapter.initialize();
    const socket = MockAcpWebSocket.instances[0];
    expect(socket).toBeDefined();
    socket?.open();
    await expect.poll(() => socket?.sent.length).toBe(1);
    expect(sent(socket!, 0)).toMatchObject({
      method: 'initialize',
      params: { clientCapabilities: { auth: { terminal: true } } },
    });
    socket?.receive({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'oh-my-pi', version: '17.0.1' },
        authMethods: [
          {
            type: 'terminal',
            id: 'terminal',
            name: 'Set up Oh My Pi in terminal',
            args: ['--acp-auth-terminal'],
          },
        ],
      },
    });
    await initializing;

    await expect(adapter.createAgentAuthPty?.('terminal')).resolves.toEqual({
      id: 'pty-auth',
      title: 'Set up Oh My Pi in terminal',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      command: 'omp',
      args: ['--acp-auth-terminal'],
    });

    const authenticating = adapter.authenticateAgent?.('terminal');
    await expect.poll(() => socket?.sent.length).toBe(2);
    expect(sent(socket!, 1)).toMatchObject({
      method: 'authenticate',
      params: { methodId: 'terminal' },
    });
    socket?.receive({ jsonrpc: '2.0', id: 2, result: {} });
    await authenticating;
  });
});
