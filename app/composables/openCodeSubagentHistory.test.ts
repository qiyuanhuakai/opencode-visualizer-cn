import { afterEach, expect, it, vi } from 'vitest';
import { createOpenCodeSubagentHistory } from './openCodeSubagentHistory';
import { createBackendHistoryStorage } from '../utils/backendHistoryStorage';
import { makeAssistantMessage, makeTextPart } from '../components/historyTestBuilders';

afterEach(() => { vi.restoreAllMocks(); });

function childEntry() {
  return { info: makeAssistantMessage('child', 'child-answer', 'child-user', 1),
    parts: [makeTextPart('child-answer', 'child', 'Observed before the server discarded it')] };
}

it('records live child history without a session switch or history-window click and restores after reload', async () => {
  const scope = 'stream-before-discard';
  const history = createOpenCodeSubagentHistory({ getScope: () => scope, isActive: () => true,
    getRootSessionId: () => 'root', getMemoryEntries: () => [] });
  history.record(childEntry());
  await history.flush();
  vi.resetModules();
  const reloaded = await import('./openCodeSubagentHistory');
  const fresh = reloaded.createOpenCodeSubagentHistory({ getScope: () => scope, isActive: () => true,
    getRootSessionId: () => 'root', getMemoryEntries: () => [] });
  const failedBackend = vi.fn(async () => { throw new Error('Discarded upstream'); });
  const read = fresh.loader(scope, failedBackend);
  expect(failedBackend).not.toHaveBeenCalled();
  expect(await read('child')).toEqual([childEntry()]);
  expect(failedBackend).not.toHaveBeenCalled();
});

it('does not hydrate child history until its lazy loader is invoked', async () => {
  const read = vi.fn(async () => [childEntry()]);
  const history = createOpenCodeSubagentHistory({ getScope: () => 'lazy', isActive: () => true,
    getRootSessionId: () => 'root', getMemoryEntries: () => [],
    createStore: () => ({ read, merge: async (_id, entries) => [...entries], flush: async () => {} }) });
  const loader = history.loader('lazy', vi.fn(async () => []));
  expect(read).not.toHaveBeenCalled();
  expect(await loader('child')).toEqual([childEntry()]);
  expect(read).toHaveBeenCalledOnce();
});

it('retains a late observed child when the backend returns an empty history', async () => {
  let observed = false;
  const history = createOpenCodeSubagentHistory({ getScope: () => 'empty-race', isActive: () => true,
    getRootSessionId: () => 'root', getMemoryEntries: () => observed ? [childEntry()] : [] });
  const read = history.loader('empty-race', async () => { observed = true; return []; });
  expect(await read('child')).toEqual([childEntry()]);
});

it('binds queued live records to their original backend scope', async () => {
  let scope = 'record-origin';
  const history = createOpenCodeSubagentHistory({ getScope: () => scope, isActive: () => true,
    getRootSessionId: () => 'root', getMemoryEntries: () => [] });
  history.record(childEntry());
  scope = 'different-server';
  await history.flush();
  expect(await createBackendHistoryStorage({ backend: 'opencode', scope }).read('child')).toEqual([]);
  expect(await createBackendHistoryStorage({ backend: 'opencode', scope: 'record-origin' }).read('child')).toEqual([childEntry()]);
});
