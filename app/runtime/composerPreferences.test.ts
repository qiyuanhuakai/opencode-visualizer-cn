import { expect, it } from 'vitest';
import { createComposerPreferences } from './composerPreferences';
import { DraftStorageError } from './migration/draftChunks';

function fixture() {
  const values = new Map<string, unknown>();
  let quota = false;
  const store = {
    readCheckpoint: async (key: string) => structuredClone(values.get(key)),
    compareAndSetCheckpoint: async (key: string, expected: unknown, value: unknown) => {
      if (quota) throw new DOMException('Storage quota exhausted', 'QuotaExceededError');
      if (JSON.stringify(values.get(key)) !== JSON.stringify(expected)) throw new DraftStorageError('conflict');
      values.set(key, structuredClone(value));
    },
  };
  return { values, store, quota: (value: boolean) => { quota = value; } };
}

it('retains a loaded preference CAS base and never overwrites a concurrent winner', async () => {
  const { values, store } = fixture();
  const first = createComposerPreferences(store, async () => null);
  const second = createComposerPreferences(store, async () => null);
  await first.read('qualified-A', 'normal-A');
  await second.read('qualified-A', 'normal-A');
  const winner = { agent: 'other', model: 'new', variant: 'high' };
  await second.write('qualified-A', winner);
  await expect(first.write('qualified-A', { agent: 'stale', model: '', variant: '' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(first.retry()).rejects.toMatchObject({ code: 'conflict' });
  expect(values.get('composer-settings:qualified-A')).toEqual(winner);
  expect(first.recoveryPending).toBe(true);
});

it('preserves quota-failed settings until retry without silently changing the CAS base', async () => {
  const state = fixture();
  const preferences = createComposerPreferences(state.store, async () => ({ messageInput: 'private body', agent: 'old', model: 'legacy', variant: 'low' }));
  expect(await preferences.read('qualified-A', 'normal-A')).toEqual({ agent: 'old', model: 'legacy', variant: 'low' });
  state.quota(true);
  const edit = { agent: 'new', model: 'selected', variant: 'high' };
  await expect(preferences.write('qualified-A', edit)).rejects.toMatchObject({ name: 'QuotaExceededError' });
  await expect(preferences.read('qualified-B', 'normal-B')).rejects.toMatchObject({ code: 'paused' });
  state.quota(false);
  await preferences.retry();
  expect(preferences.recoveryPending).toBe(false);
  expect(state.values.get('composer-settings:qualified-A')).toEqual(edit);
  expect(JSON.stringify([...state.values])).not.toContain('private body');
});

it('bounds setting payloads and refuses stale delayed reads', async () => {
  const { store } = fixture();
  let release = (_value: unknown) => {};
  const legacy = new Promise<unknown>(resolve => { release = resolve; });
  const preferences = createComposerPreferences(store, context => context === 'slow' ? legacy : Promise.resolve(null));
  const slow = preferences.read('qualified-A', 'slow');
  await preferences.read('qualified-B', 'fast');
  release({ agent: 'stale', model: '', variant: '' });
  await expect(slow).rejects.toMatchObject({ code: 'conflict' });
  await expect(preferences.write('qualified-A', { agent: '', model: '', variant: '' })).rejects.toMatchObject({ code: 'conflict' });
  await expect(preferences.write('qualified-B', { agent: '界'.repeat(4000), model: '', variant: '' })).rejects.toMatchObject({ code: 'invalid_chunk' });
  expect(preferences.recoveryPending).toBe(false);
  await preferences.write('qualified-B', { agent: 'current', model: '', variant: '' });
});
