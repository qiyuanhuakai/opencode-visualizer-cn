import { nextTick, ref, shallowRef } from 'vue';
import type { ConnectionProfileId } from '../../shared/runtime/identity.js';
import { PinStore } from '../runtime/pinStore';
import type { PinRecord } from '../runtime/pinStore';
import type { QualifiedSession } from '../runtime/selectionScope';

type Storage = Pick<PinStore, 'get' | 'set' | 'page' | 'usage' | 'close'>;

export function createRuntimePins(options: {
  profileId: ConnectionProfileId;
  clientOrigin: string;
  openStore?: () => Promise<Storage>;
  title?: (selection: QualifiedSession) => string | undefined;
}) {
  const records = shallowRef<readonly PinRecord[]>([]);
  const selected = shallowRef<QualifiedSession | null>(null);
  const pinned = ref<boolean | null>(null);
  const busy = ref(false);
  const error = ref('');
  const opened = ref(false);
  const hasNext = ref(false);
  let storage: Promise<Storage> | undefined;
  let loadedStore: Storage | undefined;
  let page: Awaited<ReturnType<Storage['page']>> | undefined;
  let after: readonly string[] | undefined;
  let next: readonly string[] | null = null;
  let sequence = 0;
  let disposed = false;
  let pending = 0;
  let queue = Promise.resolve();
  let selectionTask: Promise<void> | undefined;
  let readSequence = -1;
  const store = () => storage ??= (options.openStore ?? (() => PinStore.open()))().then(database => {
    loadedStore = database; return database;
  }).catch(failure => { storage = undefined; throw failure; });

  async function releasePage() {
    const old = page; page = undefined; records.value = [];
    await nextTick(); old?.release();
  }
  async function loadPage(database: Storage) {
    await releasePage();
    if (disposed || !opened.value) return;
    const loaded = await database.page({ profileId: options.profileId, after, limit: 100 });
    if (disposed || !opened.value) { loaded.release(); return; }
    page = loaded; next = loaded.next; hasNext.value = next !== null;
    records.value = loaded.records.filter(record => record.pinned && record.clientOrigin === options.clientOrigin);
  }
  function run(action: (database: Storage) => Promise<void>): Promise<void> {
    if (disposed) return Promise.resolve();
    pending += 1; busy.value = true;
    const operation = queue.then(async () => { if (!disposed) { error.value = ''; await action(await store()); } })
      .catch(() => { if (!disposed) error.value = 'Pinned sessions could not be loaded or saved.'; })
      .finally(() => { pending -= 1; busy.value = pending > 0; });
    queue = operation; return operation;
  }
  function refreshSelected(): Promise<void> {
    if (selectionTask) return selectionTask;
    selectionTask = run(async database => {
      do {
        const token = sequence, captured = selected.value;
        await releasePage();
        if (captured && !disposed && token === sequence) {
          const entry = await database.get({ selection: captured, clientOrigin: options.clientOrigin });
          if (!disposed && token === sequence) pinned.value = entry?.record.pinned ?? false;
          entry?.release();
        }
        readSequence = token;
        if (token === sequence) await loadPage(database);
      } while (!disposed && readSequence !== sequence);
    }).finally(() => {
      selectionTask = undefined;
      if (!disposed && !error.value && readSequence !== sequence) void refreshSelected();
    });
    return selectionTask;
  }

  return {
    records, selected, pinned, busy, error, opened, hasNext,
    title: (selection: QualifiedSession) => (selection.profileId === options.profileId ? options.title?.(selection) : undefined) || selection.session.nativeSessionId,
    setSelected(selection: QualifiedSession | null) {
      sequence += 1;
      selected.value = selection?.profileId === options.profileId ? selection : null;
      pinned.value = null;
      return refreshSelected();
    },
    toggleSelected() {
      const captured = selected.value, token = sequence;
      if (!captured) return Promise.resolve();
      return run(async database => {
        await releasePage();
        if (token !== sequence || disposed) return;
        const identity = { selection: captured, clientOrigin: options.clientOrigin };
        const existing = await database.get(identity);
        const revision = (existing?.record.revision ?? 0) + 1;
        const value = !(existing?.record.pinned ?? false);
        existing?.release();
        if (token !== sequence || disposed) return;
        await database.set({ ...identity, revision, pinned: value });
        if (token === sequence && !disposed) pinned.value = value;
        await loadPage(database);
      });
    },
    setPinned(selections: readonly QualifiedSession[], value: boolean) {
      return run(async database => {
        await releasePage();
        for (const selection of selections) {
          if (selection.profileId !== options.profileId || disposed) break;
          const identity = { selection, clientOrigin: options.clientOrigin };
          const existing = await database.get(identity);
          const revision = (existing?.record.revision ?? 0) + 1;
          const previous = existing?.record.pinned ?? false;
          existing?.release();
          if (disposed) break;
          if (previous !== value) await database.set({ ...identity, revision, pinned: value });
        }
        await loadPage(database);
      }).then(() => refreshSelected());
    },
    show() { opened.value = true; after = undefined; return run(loadPage); },
    nextPage() {
      if (!next || busy.value) return Promise.resolve();
      after = next; return run(loadPage);
    },
    firstPage() { after = undefined; return run(loadPage); },
    hide() { opened.value = false; hasNext.value = false; return run(releasePage); },
    usage: () => loadedStore?.usage() ?? { residentBytes: 0, reservedBytes: 0, entries: 0 },
    async dispose() {
      disposed = true; sequence += 1; opened.value = false; selected.value = null; pinned.value = null;
      await queue; await releasePage();
      if (storage) (await storage).close();
    },
  };
}

export type RuntimePinsState = ReturnType<typeof createRuntimePins>;
