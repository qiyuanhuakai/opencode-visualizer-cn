type Entry = {
  readonly info: Record<string, unknown> & { readonly id: string };
  readonly parts: readonly (Record<string, unknown> & { readonly id: string })[];
};
type Operation = {
  readonly threadId: string;
  readonly execute: () => Promise<void>;
  pending: Promise<void> | null;
  failure?: Error;
};

const histories = new Map<string, Map<string, Entry> | null>();
const operations = new Set<Operation>();
const reads = new Map<string, symbol>();
const listeners = new Set<(threadId: string) => void>();
let unsubscribe: (() => void) | undefined;

export function onNativeAuxiliaryHistoryChanged(listener: (threadId: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function initializeNativeAuxiliaryStorage() {
  const database = nativeAuxiliaryDatabase();
  if (!database || unsubscribe) return;
  unsubscribe = database.onHistoryChanged((threadId) => {
    if (!histories.has(threadId)) return;
    void hydrateNativeAuxiliaryHistory(threadId).then(() => {
      for (const listener of listeners) listener(threadId);
    }).catch((error: unknown) => {
      console.error('[Codex] Unable to refresh native history', error instanceof Error ? error.message : String(error));
    });
  });
}

export async function hydrateNativeAuxiliaryHistory(threadId: string) {
  const database = nativeAuxiliaryDatabase();
  if (!database) return;
  initializeNativeAuxiliaryStorage();
  const token = Symbol(threadId);
  reads.set(threadId, token);
  const original = new Map(histories.get(threadId));
  const loaded = new Map<string, Entry>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await database.readHistory({ threadId, cursor, limit: 200 });
    if (reads.get(threadId) !== token) return;
    for (const value of page.entries) {
      const entry = parseEntry(value);
      loaded.set(entry.info.id, mergeEntry(loaded.get(entry.info.id), entry));
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Native history returned a repeated cursor');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const pending = [...operations].some(operation => operation.threadId === threadId);
  for (const [id, entry] of histories.get(threadId) ?? []) {
    if (pending || original.get(id) !== entry) loaded.set(id, mergeEntry(loaded.get(id), entry));
  }
  histories.delete(threadId);
  histories.set(threadId, loaded.size ? loaded : null);
  for (const id of histories.keys()) {
    if (histories.size <= 5) break;
    if (id !== threadId && ![...operations].some(operation => operation.threadId === id)) histories.delete(id);
  }
}

export function nativeAuxiliaryDatabase() {
  return typeof window === 'undefined' ? undefined : window.electronAPI?.sessionDatabase;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEntry(value: unknown): Entry {
  if (!isRecord(value) || !isRecord(value.info) || typeof value.info.id !== 'string' || !Array.isArray(value.parts)) {
    throw new TypeError('Invalid native auxiliary history entry');
  }
  const parts = value.parts.map((part: unknown) => {
    if (!isRecord(part) || typeof part.id !== 'string') throw new TypeError('Invalid native auxiliary history part');
    return { ...part, id: part.id };
  });
  return { info: { ...value.info, id: value.info.id }, parts };
}

function terminal(part: Record<string, unknown>) {
  return part.type === 'tool' && isRecord(part.state) && (part.state.status === 'completed' || part.state.status === 'error');
}

function mergeEntry(previous: Entry | undefined, incoming: Entry): Entry {
  const parts = new Map(previous?.parts.map(part => [part.id, part]));
  for (const part of incoming.parts) {
    const old = parts.get(part.id);
    if (old && terminal(old) && !terminal(part)) continue;
    parts.set(part.id, part);
  }
  return { info: incoming.info, parts: [...parts.values()] };
}

function run(operation: Operation) {
  operation.failure = undefined;
  operation.pending = operation.execute().then(() => { operations.delete(operation); }, (error: unknown) => {
    operation.failure = error instanceof Error ? error : new Error(String(error));
    console.error('[Codex] Native history write failed; retained for retry', operation.failure.message);
  }).finally(() => { operation.pending = null; });
}

function enqueue(threadId: string, execute: () => Promise<void>) {
  const operation: Operation = { threadId, execute, pending: null };
  operations.add(operation);
  run(operation);
}

export function readNativeAuxiliarySnapshot(threadId: string): unknown {
  const history = histories.get(threadId);
  return history ? structuredClone({ version: 1, threadId, entries: [...history.values()] }) : null;
}

export function writeNativeAuxiliarySnapshot(threadId: string, snapshot: unknown) {
  const database = nativeAuxiliaryDatabase();
  if (!database) return;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.entries)) throw new TypeError('Invalid native auxiliary snapshot');
  const history = histories.get(threadId) ?? new Map<string, Entry>();
  const changed: Entry[] = [];
  for (const value of snapshot.entries) {
    const incoming = parseEntry(value);
    const previous = history.get(incoming.info.id);
    const merged = mergeEntry(previous, incoming);
    const oldParts = new Map(previous?.parts.map(part => [part.id, part]));
    const parts = merged.parts.filter(part => JSON.stringify(oldParts.get(part.id)) !== JSON.stringify(part));
    if (parts.length || JSON.stringify(previous?.info) !== JSON.stringify(merged.info)) {
      // Clone only changed entries: Vue proxies cannot cross Electron IPC.
      const plain: unknown = JSON.parse(JSON.stringify({ info: merged.info, parts }));
      const committed = parseEntry(plain);
      changed.push(committed);
      history.set(merged.info.id, mergeEntry(previous, committed));
    }
  }
  histories.set(threadId, history);
  if (changed.length) enqueue(threadId, () => database.upsertHistory({ threadId, entries: changed }));
}

export function clearNativeAuxiliaryHistory(threadId: string) {
  const database = nativeAuxiliaryDatabase();
  if (!database) return;
  for (const operation of operations) {
    if (operation.threadId === threadId) operations.delete(operation);
  }
  histories.set(threadId, null);
  reads.delete(threadId);
  enqueue(threadId, () => database.clearHistory({ threadId }));
}

export async function flushNativeAuxiliaryStorage() {
  for (const operation of operations) {
    if (operation.failure) run(operation);
  }
  while ([...operations].some(operation => operation.pending)) {
    await Promise.all([...operations].flatMap(operation => operation.pending ? [operation.pending] : []));
  }
  const failure = [...operations].find(operation => operation.failure)?.failure;
  if (failure) throw failure;
  await nativeAuxiliaryDatabase()?.flush();
}

if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe?.(); listeners.clear(); });
