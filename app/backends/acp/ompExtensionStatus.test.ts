import { describe, expect, it } from 'vitest';
import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket, sent } from './acpTestHarness';

describe('Oh My Pi extension status adaptation', () => {
  it('maps one safe structured snapshot into MCP, plugin, and skill status', async () => {
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
        agentCapabilities: { sessionCapabilities: {} },
      },
    });
    await initializing;
    if (!socket) throw new Error('Missing mock ACP socket.');

    const statuses = Promise.all([
      adapter.getMcpStatus(),
      adapter.getSkillStatus(),
      adapter.getPluginStatus(),
    ]);
    await expect.poll(() => socket.sent.length).toBe(2);
    expect(sent(socket, 1)).toMatchObject({ method: '_omp/extensions', params: {} });
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        extensions: [
          {
            id: 'mcp:context7',
            kind: 'mcp',
            name: 'context7',
            displayName: 'context7',
            path: '/safe/mcp.json',
            source: { provider: 'native', providerName: 'Native', level: 'user' },
            state: 'active',
            raw: { token: 'must-not-leak' },
          },
          {
            id: 'skill:review-work',
            kind: 'skill',
            name: 'review-work',
            displayName: 'Review Work',
            path: '/safe/SKILL.md',
            source: { provider: 'agents', providerName: 'Agents', level: 'user' },
            state: 'disabled',
          },
          {
            id: 'extension-module:demo',
            kind: 'extension-module',
            name: 'demo',
            displayName: 'Demo',
            path: '/safe/demo.ts',
            source: { provider: 'native', providerName: 'Native', level: 'project' },
            state: 'active',
          },
        ],
      },
    });

    const [mcp, skills, plugins] = await statuses;
    expect(mcp).toEqual({ context7: { status: 'configured' } });
    expect(skills).toEqual([{ name: 'Review Work', enabled: false, path: '/safe/SKILL.md' }]);
    expect(plugins).toEqual([
      { id: 'extension-module:demo', name: 'Demo', enabled: true, installed: true, accessible: true },
    ]);
    expect(JSON.stringify([mcp, skills, plugins])).not.toContain('must-not-leak');
    expect(socket.sent).toHaveLength(2);
  });
});
