import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionHistoryPage } from '../../types/sessionDatabase';
import type { PendingLegacyWrite } from '../../runtime/migration/writerFreeze';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function entry(id: string, text = id) {
  return {
    info: { id, sessionID: 'thread', role: 'assistant', parentID: 'user', time: { created: 1 } },
    parts: [{ id: `${id}:part`, messageID: id, sessionID: 'thread', type: 'reasoning', text, time: { start: 1 } }],
  };
}

function fixture() {
  const batches: unknown[][] = [];
  const database = {
    readHistory: vi.fn<() => Promise<SessionHistoryPage>>(async () => ({ entries: [], nextCursor: null })),
    upsertHistory: vi.fn(async (request: { threadId: string; entries: unknown[] }) => { batches.push(request.entries); }),
    clearHistory: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    onHistoryChanged: () => () => {},
  };
  vi.stubGlobal('window', { electronAPI: { sessionDatabase: database } });
  return { database, batches };
}

describe('native auxiliary history admitted through the legacy writer freeze', () => {
  it('keeps a budget-rejected diff out of the in-memory cache so an identical retry still persists it', async () => {
    // Given one durable entry written while legacy writers are still open.
    vi.resetModules();
    const gate = await import('../../runtime/migration/writerFreeze');
    const native = await import('./nativeAuxiliaryStorage');
    const f = fixture();
    const durable = { version: 1, threadId: 'thread', entries: [entry('e1')] };
    const grown = { version: 1, threadId: 'thread', entries: [entry('e1'), entry('e2')] };
    native.writeNativeAuxiliarySnapshot('thread', durable);
    await native.flushNativeAuxiliaryStorage();
    expect(f.batches).toEqual([[entry('e1')]]);

    // When the writers freeze and the bounded retention queue is already full.
    const persisted: PendingLegacyWrite[] = [];
    await gate.freezeLegacyWriters({ clientOrigin: 'client-a', persist: async write => { persisted.push(write); } });
    for (let index = 0; index < 32; index++) gate.retainFrozenLegacyWrite({ channel: 'storage', key: `filler-${index}`, value: 'x' });
    expect(gate.writerPendingState()).toMatchObject({ count: 32, failed: false });

    // Then the new diff is rejected, and the cache must not claim to hold it.
    expect(() => native.writeNativeAuxiliarySnapshot('thread', grown)).toThrow('pending_budget');
    expect(native.readNativeAuxiliarySnapshot('thread')).toEqual(durable);

    // And once capacity returns, retrying the identical snapshot still persists e2.
    await gate.retryFrozenLegacyWrites();
    native.writeNativeAuxiliarySnapshot('thread', grown);
    await gate.flushFrozenLegacyWrites();
    expect(native.readNativeAuxiliarySnapshot('thread')).toEqual(grown);
    expect(persisted.filter(write => write.channel === 'native-history')).toEqual([expect.objectContaining({ channel: 'native-history', key: 'thread' })]);
  });

  it('keeps a budget-rejected clear from dropping the local history it could not delete', async () => {
    // Given a durable entry and a frozen writer gate whose retention queue is full.
    vi.resetModules();
    const gate = await import('../../runtime/migration/writerFreeze');
    const native = await import('./nativeAuxiliaryStorage');
    const f = fixture();
    const durable = { version: 1, threadId: 'thread', entries: [entry('e1')] };
    const persisted: PendingLegacyWrite[] = [];
    native.writeNativeAuxiliarySnapshot('thread', durable);
    await native.flushNativeAuxiliaryStorage();
    await gate.freezeLegacyWriters({ clientOrigin: 'client-a', persist: async write => { persisted.push(write); } });
    for (let index = 0; index < 32; index++) gate.retainFrozenLegacyWrite({ channel: 'storage', key: `filler-${index}`, value: 'x' });

    // When the thread is cleared but the delete is refused by the budget.
    expect(() => native.clearNativeAuxiliaryHistory('thread')).toThrow('pending_budget');
    expect(f.database.clearHistory).not.toHaveBeenCalled();
    // Then the local history survives, because the durable delete never happened.
    expect(native.readNativeAuxiliarySnapshot('thread')).toEqual(durable);

    // And once capacity returns, retrying the identical clear is admitted.
    await gate.retryFrozenLegacyWrites();
    native.clearNativeAuxiliaryHistory('thread');
    await gate.flushFrozenLegacyWrites();
    expect(native.readNativeAuxiliarySnapshot('thread')).toBeNull();
    expect(f.database.clearHistory).not.toHaveBeenCalled();
    expect(persisted.filter(write => write.channel === 'native-history')).toEqual([expect.objectContaining({ channel: 'native-history', key: 'thread', value: null })]);
  });
});
