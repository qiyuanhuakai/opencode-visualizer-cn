import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackendSessionInfo } from '../../types/backend-domain';
import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';

describe('ACP prompt session status', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('publishes busy and idle session updates around a prompt', async () => {
    const { adapter, socket } = await initializeAdapter();
    const creating = adapter.createSession('/workspace/project');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: { sessionId: 'session-1', configOptions: [] },
    });
    await creating;
    const sessionUpdates: BackendSessionInfo[] = [];
    adapter.onEvent((event) => {
      if (event.type === 'session.updated') sessionUpdates.push(event.info);
    });

    const prompting = adapter.sendPromptAsync('session-1', {
      directory: '/workspace/project',
      agent: 'default',
      model: { providerID: 'acp', modelID: 'default' },
      parts: [{ type: 'text', text: 'Hello' }],
    });
    await expect.poll(() => socket.sent.length).toBe(3);
    expect(sessionUpdates.at(-1)).toEqual(expect.objectContaining({ status: 'busy' }));

    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled' } });
    await prompting;

    expect(sessionUpdates.at(-1)).toEqual(expect.objectContaining({ status: 'idle' }));
  });

  it('waits for a prompt response beyond the default RPC timeout while permission is pending', async () => {
    const { adapter, socket } = await initializeAdapter();
    const creating = adapter.createSession('/workspace/project');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1', configOptions: [] } });
    await creating;

    vi.useFakeTimers();
    try {
      const prompting = adapter.sendPromptAsync('session-1', {
        directory: '/workspace/project',
        agent: 'default',
        model: { providerID: 'acp', modelID: 'default' },
        parts: [{ type: 'text', text: 'Write approval.txt' }],
      });
      for (let attempt = 0; attempt < 20 && socket.sent.length < 3; attempt++) {
        await Promise.resolve();
      }
      expect(socket.sent).toHaveLength(3);

      const settled = vi.fn();
      void prompting.then(settled, settled);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(settled).not.toHaveBeenCalled();
      socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
      await expect(prompting).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
