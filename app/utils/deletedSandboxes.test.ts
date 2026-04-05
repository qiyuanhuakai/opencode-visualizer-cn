import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isSandboxMarkedDeleted,
  markSandboxDeleted,
  pruneDeletedSandboxStore,
  readDeletedSandboxStore,
  unmarkSandboxDeleted,
  writeDeletedSandboxStore,
  type DeletedSandboxStore,
} from './deletedSandboxes';
import { StorageKeys, storageKey } from './storageKeys';

describe('deletedSandboxes', () => {
  let store: Record<string, string | null>;

  beforeEach(() => {
    store = {};
    const storage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    } as unknown as Storage;

    vi.stubGlobal('window', {
      localStorage: storage,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('normalizes and persists deleted sandbox directories', () => {
    writeDeletedSandboxStore({
      p1: ['/tmp/a/', '/tmp/a', '   ', '/tmp/b//'],
    });

    expect(readDeletedSandboxStore()).toEqual({
      p1: ['/tmp/a', '/tmp/b'],
    });
  });

  it('marks and unmarks sandbox deletions immutably', () => {
    const initial: DeletedSandboxStore = {};
    const marked = markSandboxDeleted(initial, 'p1', '/tmp/a/');
    const remarked = markSandboxDeleted(marked, 'p1', '/tmp/a');
    const unmarked = unmarkSandboxDeleted(remarked, 'p1', '/tmp/a');

    expect(initial).toEqual({});
    expect(marked).toEqual({ p1: ['/tmp/a'] });
    expect(remarked).toBe(marked);
    expect(unmarked).toEqual({});
  });

  it('reports whether a sandbox is marked deleted', () => {
    const deleted: DeletedSandboxStore = {
      p1: ['/tmp/a'],
    };

    expect(isSandboxMarkedDeleted(deleted, 'p1', '/tmp/a/')).toBe(true);
    expect(isSandboxMarkedDeleted(deleted, 'p1', '/tmp/b')).toBe(false);
  });

  it('prunes deleted sandbox entries once they disappear from live state', () => {
    const deleted: DeletedSandboxStore = {
      p1: ['/tmp/a', '/tmp/b'],
      p2: ['/tmp/c'],
    };

    expect(
      pruneDeletedSandboxStore(deleted, {
        p1: ['/tmp/b'],
        p2: [],
      }),
    ).toEqual({
      p1: ['/tmp/b'],
    });
  });

  it('removes storage key when persisted store is empty', () => {
    store[storageKey(StorageKeys.state.deletedSandboxes)] = JSON.stringify({ p1: ['/tmp/a'] });

    writeDeletedSandboxStore({});

    expect(store[storageKey(StorageKeys.state.deletedSandboxes)]).toBeUndefined();
  });
});
