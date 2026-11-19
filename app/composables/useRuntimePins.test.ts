import { expect, it, vi } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { PinIdentity, PinRecord } from '../runtime/pinStore';
import type { PinStore } from '../runtime/pinStore';
import { createRuntimePins } from './useRuntimePins';

const profileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const selection = (id: string) => ({ profileId, session: parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: id }) });

function fixture() {
  const rows = new Map<string, PinRecord>();
  let leased = false;
  const acquire = () => { if (leased) throw new Error('Overlapping pin memory leases'); leased = true; return () => { leased = false; }; };
  let acknowledge: Promise<void> = Promise.resolve();
  const database: Pick<PinStore, 'get' | 'set' | 'page' | 'usage' | 'close'> = {
    get: vi.fn(async (identity: PinIdentity) => {
      const release = acquire(); const record = rows.get(identity.selection.session.nativeSessionId);
      if (!record) { release(); return undefined; }
      return { record, release };
    }),
    set: vi.fn(async (record: PinRecord) => {
      const release = acquire();
      try { await acknowledge; rows.set(record.selection.session.nativeSessionId, record); } finally { release(); }
    }),
    page: vi.fn(async () => ({ records: [...rows.values()], next: null, release: acquire() })),
    usage: () => ({ residentBytes: leased ? 512 * 1024 : 0, reservedBytes: 0, entries: leased ? 100 : 0 }),
    close: vi.fn(),
  };
  const state = createRuntimePins({ profileId, clientOrigin: 'http://vis.test', openStore: async () => database });
  return { state, database, rows, blockSave(promise: Promise<void>) { acknowledge = promise; } };
}

it('releases the visible page before reading/writing and changes pin status only after durable acknowledgement', async () => {
  const { state, database, rows, blockSave } = fixture();
  await state.setSelected(selection('one')); await state.show();
  let acknowledge = () => {};
  blockSave(new Promise<void>(resolve => { acknowledge = resolve; }));
  const pending = state.toggleSelected();
  await vi.waitFor(() => expect(database.set).toHaveBeenCalledOnce());
  expect(state.pinned.value).toBe(false); expect(rows.size).toBe(0);
  acknowledge(); await pending;
  expect(state.pinned.value).toBe(true); expect(state.records.value).toHaveLength(1); expect(state.error.value).toBe('');
  await state.toggleSelected();
  expect(state.pinned.value).toBe(false); expect(rows.get('one')?.revision).toBe(2); expect(state.records.value).toHaveLength(0);
  await state.dispose(); expect(database.close).toHaveBeenCalledOnce(); expect((await database.usage()).residentBytes).toBe(0);
});

it('coalesces rapid selections instead of queuing resident identity copies for every session', async () => {
  const { state, database } = fixture();
  const pending = state.setSelected(selection('initial'));
  for (let index = 0; index < 1000; index++) void state.setSelected(selection(`latest-${index}`));
  await pending;
  expect(state.selected.value?.session.nativeSessionId).toBe('latest-999');
  expect(state.pinned.value).toBe(false); expect(state.error.value).toBe('');
  expect(database.get).toHaveBeenCalledTimes(1);
  await state.dispose();
});
