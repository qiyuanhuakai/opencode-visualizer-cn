import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AcpClientEvent } from './acpClient';
import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';
import { clearPromptGeneration } from './promptGeneration';

const prompt = {
  directory: '/workspace/project',
  agent: 'default',
  model: { providerID: 'acp', modelID: 'default' },
  parts: [{ type: 'text' as const, text: 'Hello' }],
};

async function createSession() {
  const initialized = await initializeAdapter();
  const creating = initialized.adapter.createSession('/workspace/project');
  await expect.poll(() => initialized.socket.sent.length).toBe(2);
  initialized.socket.receive({
    jsonrpc: '2.0',
    id: 2,
    result: { sessionId: 'session-1', configOptions: [] },
  });
  await creating;
  return initialized;
}

describe('ACP live completion events', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
  });

  it('keeps reconnected prompt markers when an old generation finishes', () => {
    const prompting = new Map([['session-1', 2]]);
    const aborted = new Map([['session-1', 2]]);

    clearPromptGeneration(prompting, 'session-1', 1);
    clearPromptGeneration(aborted, 'session-1', 1);

    expect(prompting.get('session-1')).toBe(2);
    expect(aborted.get('session-1')).toBe(2);
  });

  it('emits one promptCompleted event with the completed assistant message id', async () => {
    const { adapter, socket } = await createSession();
    const events: AcpClientEvent[] = [];
    adapter.onEvent((event) => events.push(event));

    const prompting = adapter.sendPromptAsync('session-1', prompt);
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompting;

    expect(events.filter((event) => event.type === 'session.promptCompleted')).toEqual([
      {
        type: 'session.promptCompleted',
        sessionId: 'session-1',
        completionId: 'acp:session-1:assistant:1',
      },
    ]);
  });

  it.each(['cancelled', 'error'])('suppresses %s prompt results', async (stopReason) => {
    const { adapter, socket } = await createSession();
    const listener = vi.fn();
    adapter.onEvent(listener);

    const prompting = adapter.sendPromptAsync('session-1', prompt);
    await expect.poll(() => socket.sent.length).toBe(3);
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason } });
    await prompting;

    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.promptCompleted' }),
    );
  });

  it('suppresses an explicitly aborted prompt even if the result is end_turn', async () => {
    const { adapter, socket } = await createSession();
    const listener = vi.fn();
    adapter.onEvent(listener);

    const prompting = adapter.sendPromptAsync('session-1', prompt);
    await expect.poll(() => socket.sent.length).toBe(3);
    await adapter.abortSession('session-1');
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await prompting;

    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.promptCompleted' }),
    );
  });

  it('does not emit completion events while replaying history', async () => {
    const { adapter, socket } = await initializeAdapter();
    const listener = vi.fn();
    adapter.onEvent(listener);
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
    socket.receive({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'loaded-session',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Earlier answer' },
        },
      },
    });
    socket.receive({ jsonrpc: '2.0', id: 3, result: {} });
    await loading;

    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.promptCompleted' }),
    );
  });

  it('does not emit a completion event after disconnecting an active prompt', async () => {
    const { adapter, socket } = await createSession();
    const listener = vi.fn();
    adapter.onEvent(listener);

    const prompting = adapter.sendPromptAsync('session-1', prompt);
    await expect.poll(() => socket.sent.length).toBe(3);
    adapter.disconnect();
    socket.receive({ jsonrpc: '2.0', id: 3, result: { stopReason: 'end_turn' } });
    await expect(prompting).rejects.toThrow('WebSocket disconnected');

    expect(listener).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'session.promptCompleted' }),
    );
  });
});
