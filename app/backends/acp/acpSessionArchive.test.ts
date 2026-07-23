import { beforeEach, describe, expect, it } from 'vitest';
import { StorageKeys, storageRemove } from '../../utils/storageKeys';
import { createAcpSessionArchive } from './sessionArchive';
import { initializeAdapter, MockAcpWebSocket } from './acpTestHarness';

describe('ACP local session archive', () => {
  beforeEach(() => {
    MockAcpWebSocket.instances = [];
    storageRemove(StorageKeys.state.acpArchivedSessions);
  });

  it('persists archive state per managed agent', () => {
    const omp = createAcpSessionArchive('oh-my-pi');
    omp.set('session-1', true);

    expect(createAcpSessionArchive('oh-my-pi').has('session-1')).toBe(true);
    expect(createAcpSessionArchive('kimi-code').has('session-1')).toBe(false);
    omp.set('session-1', false);
    expect(createAcpSessionArchive('oh-my-pi').has('session-1')).toBe(false);
  });

  it('exposes archive capabilities and updates the active session locally', async () => {
    const { adapter, socket } = await initializeAdapter();
    const events: unknown[] = [];
    adapter.onEvent((event) => events.push(event));
    const creating = adapter.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({ jsonrpc: '2.0', id: 2, result: { sessionId: 'session-1' } });
    await creating;

    await adapter.updateSession('session-1', { time: { archived: 123 } });

    expect(adapter.capabilities.sessionArchive).toBe(true);
    expect(adapter.capabilities.sessionUnarchive).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'session.updated',
        info: expect.objectContaining({ time: expect.objectContaining({ archived: 123 }) }),
      }),
    );
  });
});
