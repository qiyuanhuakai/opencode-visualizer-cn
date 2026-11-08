// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserLegacySource } from './legacyBrowserSource.js';

const ORIGIN = 'https://app.example.test';
const scopeHash = 'a'.repeat(32);
const backendKey = `state.backendHistory.v1.${scopeHash}.ses_1`;

type Row = Readonly<{ key: readonly [string, string]; value: string }>;

function createStorage(entries: Readonly<Record<string, string>>): Storage {
  const keys = Object.keys(entries).sort();
  return {
    length: keys.length,
    key: (index: number) => keys[index] ?? null,
    getItem: (name: string) => (Object.hasOwn(entries, name) ? entries[name] : null),
  } as unknown as Storage;
}

// The rows the renderer's backend history writer creates: an array key whose
// first element is the storage key and whose second is the message id.
function createIndexedDB(rows: readonly Row[], databases: readonly string[] = ['opencode.backendHistory']): IDBFactory {
  return {
    databases: async () => databases.map((name) => ({ name })),
    open: () => {
      const request = {} as IDBRequest<IDBDatabase>;
      const transaction = {
        objectStore: () => store,
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
      };
      const store = {
        contains: () => true,
        openCursor: (after: IDBValidKey | undefined) => {
          const cursorRequest = {} as IDBRequest<IDBCursorWithValue | null>;
          const start = rows.findIndex((row) => after === undefined || compare(row.key, after) > 0);
          let index = start === -1 ? rows.length : start;
          const advance = () => {
            const row = rows[index];
            Object.defineProperty(cursorRequest, 'result', { value: row ? { key: row.key, value: row.value } as unknown as IDBCursorWithValue : null, configurable: true });
            index += 1;
            cursorRequest.onsuccess?.(new Event('success'));
            queueMicrotask(() => transaction.oncomplete?.());
          };
          queueMicrotask(() => advance());
          return cursorRequest;
        },
      };
      const db = {
        objectStoreNames: { contains: (store: string) => store === 'histories' },
        transaction: () => transaction,
        close: () => {},
      };
      queueMicrotask(() => {
        Object.defineProperty(request, 'result', { value: db as unknown as IDBDatabase, configurable: true });
        request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  } as unknown as IDBFactory;
}

function compare(left: readonly unknown[], right: IDBValidKey): number {
  const bound = Array.isArray(right) ? right : [right];
  for (let index = 0; index < Math.max(left.length, bound.length); index += 1) {
    const a = left[index]; const b = bound[index];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    return String(a) < String(b) ? -1 : 1;
  }
  return 0;
}

async function collect(pieces: AsyncIterable<Readonly<{ namespace: string; key: string; source: string }>>) {
  const seen: Readonly<{ namespace: string; key: string; source: string }>[] = [];
  for await (const piece of pieces) seen.push(piece);
  return seen;
}

afterEach(() => { vi.unstubAllGlobals(); });

// The cursor loop resumes from an exclusive lower bound; the fake compares keys itself.
function stubCursorBounds() { vi.stubGlobal('IDBKeyRange', { lowerBound: (value: IDBValidKey) => value }); }

describe('runtime browser legacy source namespaces', () => {
  it('maps the renderer backend-history key shape onto its scope namespace', async () => {
    // Given a browser database holding rows under the renderer's own key shape.
    vi.stubGlobal('location', { origin: ORIGIN });
    stubCursorBounds();
    const source = createBrowserLegacySource({ storage: createStorage({}), indexedDB: createIndexedDB([{ key: [backendKey, 'msg_1'], value: 'body' }]), origin: ORIGIN });
    // When the legacy source enumerates it.
    const pieces = await collect(source());
    // Then the piece carries the scope namespace instead of an unattached bucket.
    expect(pieces).toHaveLength(1);
    expect(pieces[0].namespace).toBe(`backend-history-v1:${scopeHash}`);
    expect(pieces[0].key).toBe(JSON.stringify([backendKey, 'msg_1']));
  });
  it('failure rejects a malformed scope hash instead of guessing a namespace', async () => {
    // Given a backend-history key whose scope is not a 32-hex digest.
    vi.stubGlobal('location', { origin: ORIGIN });
    stubCursorBounds();
    const malformed = `state.backendHistory.v1.nothex.${scopeHash}`;
    const source = createBrowserLegacySource({ storage: createStorage({}), indexedDB: createIndexedDB([{ key: [malformed, 'msg_1'], value: 'body' }]), origin: ORIGIN });
    // When the legacy source enumerates it.
    // Then it fails loudly rather than attaching the data to a wrong scope.
    await expect(collect(source())).rejects.toMatchObject({ code: 'unknown_namespace' });
  });
  it('keeps unrelated browser keys unattached', async () => {
    // Given a database row outside the backend-history shape.
    vi.stubGlobal('location', { origin: ORIGIN });
    stubCursorBounds();
    const source = createBrowserLegacySource({ storage: createStorage({ 'opencode.drafts.composer.v1': 'x' }), indexedDB: createIndexedDB([{ key: ['unrelated.key', 'msg_1'], value: 'body' }]), origin: ORIGIN });
    // When the legacy source enumerates it.
    const pieces = await collect(source());
    // Then those pieces stay in the unattached namespace.
    expect(pieces.map((piece) => piece.namespace)).toEqual(['unattached-legacy-local', 'unattached-legacy-local']);
  });
});
