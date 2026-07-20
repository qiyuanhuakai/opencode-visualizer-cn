import { describe, expect, it } from 'vitest';

import { createAcpAdapter } from './acpAdapter';
import { MockAcpWebSocket } from './acpTestHarness';

describe('ACP connection errors', () => {
  it('identifies the ACP WebSocket instead of Codex', async () => {
    MockAcpWebSocket.instances = [];
    const adapter = createAcpAdapter({
      url: 'ws://localhost:23004/acp/oh-my-pi',
      agentId: 'oh-my-pi',
      webSocketCtor: MockAcpWebSocket,
    });

    const initializing = adapter.initialize();
    MockAcpWebSocket.instances[0]?.fail();

    await expect(initializing).rejects.toThrow(
      'ACP WebSocket connection failed: ws://localhost:23004/acp/oh-my-pi',
    );
  });
});
