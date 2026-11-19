import { DraftStorageError } from './migration/draftChunks';
import type { DraftStore } from './draftStore';

export type ComposerPreferences = Readonly<{ agent: string; model: string; variant: string }>;
type Store = Pick<DraftStore, 'readCheckpoint' | 'compareAndSetCheckpoint'>;
const empty = Object.freeze({ agent: '', model: '', variant: '' });

function preferences(value: unknown): ComposerPreferences {
  if (value === null || value === undefined) return empty;
  if (typeof value !== 'object' || Array.isArray(value)) throw new DraftStorageError('corrupt');
  const field = (key: string): string => {
    const result: unknown = Reflect.get(value, key);
    if (result === undefined) return '';
    if (typeof result !== 'string') throw new DraftStorageError('corrupt');
    return result;
  };
  const result = Object.freeze({ agent: field('agent'), model: field('model'), variant: field('variant') });
  if (JSON.stringify(result).length > 8192 || new TextEncoder().encode(JSON.stringify(result)).length > 8192) throw new DraftStorageError('invalid_chunk');
  return result;
}

export function createComposerPreferences(store: Store, readLegacy: (context: string) => Promise<unknown>) {
  let loaded: { key: string; expected: unknown } | null = null;
  let pending: { key: string; expected: unknown; value: ComposerPreferences } | null = null;
  let generation = 0;
  function checkpoint(key: string) {
    if (!key || key.length > 16384) throw new DraftStorageError('invalid_chunk');
    return `composer-settings:${key}`;
  }
  return {
    async read(key: string, legacyContext: string): Promise<ComposerPreferences> {
      if (pending) throw new DraftStorageError('paused');
      const turn = ++generation;
      const expected = await store.readCheckpoint(checkpoint(key));
      const value = preferences(expected ?? await readLegacy(legacyContext));
      if (turn !== generation) throw new DraftStorageError('conflict');
      loaded = { key, expected };
      return value;
    },
    async write(key: string, value: ComposerPreferences): Promise<void> {
      if (pending) throw new DraftStorageError('paused');
      if (loaded?.key !== key) throw new DraftStorageError('conflict');
      generation++;
      const captured = { key, expected: loaded.expected, value: preferences(value) };
      pending = captured;
      await store.compareAndSetCheckpoint(checkpoint(key), captured.expected, captured.value);
      if (pending === captured) pending = null;
      if (loaded?.key === key) loaded = { key, expected: captured.value };
    },
    async retry(): Promise<void> {
      const captured = pending;
      if (!captured) return;
      const observed = await store.readCheckpoint(checkpoint(captured.key));
      if (JSON.stringify(observed) !== JSON.stringify(captured.value)) {
        await store.compareAndSetCheckpoint(checkpoint(captured.key), captured.expected, captured.value);
      }
      if (pending === captured) pending = null;
      if (loaded?.key === captured.key) loaded = { key: captured.key, expected: captured.value };
    },
    get recoveryPending() { return pending !== null; },
  };
}
