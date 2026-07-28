import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearOpenCodeLastSelection,
  readOpenCodeLastSelection,
  writeOpenCodeLastSelection,
} from './openCodeSelectionStorage';
import { StorageKeys, storageGet, storageSet } from './storageKeys';

const SERVER_A = 'http://host-a:4196';
const SERVER_B = 'http://host-b:5099';

const STORAGE_KEY = `opencode.${StorageKeys.state.openCodeLastSelection}`;

type FakeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

describe('openCodeSelectionStorage', () => {
  let store: Record<string, string | null>;

  beforeEach(() => {
    store = {};
    const storage: FakeStorage = {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
    };

    vi.stubGlobal('window', {
      localStorage: storage,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when nothing has been stored', () => {
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
  });

  it('round-trips a selection for one server', () => {
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });

    expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });
  });

  it('keeps selections for two servers independent without cross-clobbering', () => {
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-a',
      sessionId: 'sess-a',
      directory: '/repo/a',
    });
    writeOpenCodeLastSelection(SERVER_B, {
      projectId: 'proj-b',
      sessionId: 'sess-b',
      directory: '/repo/b',
    });

    expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
      projectId: 'proj-a',
      sessionId: 'sess-a',
      directory: '/repo/a',
    });
    expect(readOpenCodeLastSelection(SERVER_B)).toEqual({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      directory: '/repo/b',
    });

    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-a2',
      sessionId: 'sess-a2',
      directory: '/repo/a2',
    });

    expect(readOpenCodeLastSelection(SERVER_B)).toEqual({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      directory: '/repo/b',
    });
  });

  it('normalizes trailing slashes so http://host:4196/ matches http://host:4196', () => {
    writeOpenCodeLastSelection(`${SERVER_A}/`, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });

    expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });
    expect(readOpenCodeLastSelection(`${SERVER_A}/`)).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });
  });

  it('trims base URL and fields on write', () => {
    writeOpenCodeLastSelection(` ${SERVER_A}/ `, {
      projectId: '  proj-1  ',
      sessionId: ' sess-1 ',
      directory: ' /repo/one ',
    });

    expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });
  });

  it('returns null without throwing when stored JSON is corrupt', () => {
    store[STORAGE_KEY] = '{not-json';
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
  });

  it('returns null when stored value is not a plain object', () => {
    store[STORAGE_KEY] = JSON.stringify([1, 2, 3]);
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();

    store[STORAGE_KEY] = JSON.stringify('a string');
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();

    store[STORAGE_KEY] = JSON.stringify(42);
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
  });

  it('returns null when the stored record has missing or empty fields', () => {
    store[STORAGE_KEY] = JSON.stringify({
      [SERVER_A]: { projectId: '', sessionId: 'sess-1', directory: '/repo/one' },
    });
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();

    store[STORAGE_KEY] = JSON.stringify({
      [SERVER_A]: { projectId: 'proj-1', sessionId: 'sess-1' },
    });
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();

    store[STORAGE_KEY] = JSON.stringify({
      [SERVER_A]: 'garbage',
    });
    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
  });

  it('does not write records with empty identifiers', () => {
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: '',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-1',
      sessionId: '  ',
      directory: '/repo/one',
    });
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '',
    });
    writeOpenCodeLastSelection('   ', {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      directory: '/repo/one',
    });

    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
    expect(store[STORAGE_KEY] ?? null).toBeNull();
  });

  it('clearing one server leaves the other server record intact', () => {
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-a',
      sessionId: 'sess-a',
      directory: '/repo/a',
    });
    writeOpenCodeLastSelection(SERVER_B, {
      projectId: 'proj-b',
      sessionId: 'sess-b',
      directory: '/repo/b',
    });

    clearOpenCodeLastSelection(SERVER_A);

    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
    expect(readOpenCodeLastSelection(SERVER_B)).toEqual({
      projectId: 'proj-b',
      sessionId: 'sess-b',
      directory: '/repo/b',
    });
  });

  it('removes the storage key entirely when the last server record is cleared', () => {
    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-a',
      sessionId: 'sess-a',
      directory: '/repo/a',
    });

    clearOpenCodeLastSelection(SERVER_A);

    expect(readOpenCodeLastSelection(SERVER_A)).toBeNull();
    expect(store[STORAGE_KEY] ?? null).toBeNull();
  });

  it('does not touch unrelated storage keys', () => {
    storageSet(StorageKeys.state.codexActiveThread, 'thr_keep_me');
    storageSet(StorageKeys.settings.enterToSend, 'true');

    writeOpenCodeLastSelection(SERVER_A, {
      projectId: 'proj-a',
      sessionId: 'sess-a',
      directory: '/repo/a',
    });
    clearOpenCodeLastSelection(SERVER_A);

    expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_keep_me');
    expect(storageGet(StorageKeys.settings.enterToSend)).toBe('true');
  });

  describe('security hardening (F3-1: prototype pollution)', () => {
    it('reads a stored __proto__ key as null and does not pollute the prototype chain', () => {
      store[STORAGE_KEY] =
        '{"__proto__":{"projectId":"evil-proj","sessionId":"evil-sess","directory":"/evil"},' +
        `"${SERVER_A}":{"projectId":"proj-1","sessionId":"sess-1","directory":"/repo/one"}}`;

      expect(readOpenCodeLastSelection('__proto__')).toBeNull();
      expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });
      expect('projectId' in {}).toBe(false);
      expect(Object.prototype).not.toHaveProperty('projectId');
    });

    it('writeOpenCodeLastSelection with a __proto__ base URL is a safe no-op', () => {
      writeOpenCodeLastSelection('__proto__', {
        projectId: 'evil-proj',
        sessionId: 'evil-sess',
        directory: '/evil',
      });

      expect(readOpenCodeLastSelection('__proto__')).toBeNull();
      expect(store[STORAGE_KEY] ?? null).toBeNull();
      expect('projectId' in {}).toBe(false);
    });

    it('ignores constructor and prototype keys in stored JSON', () => {
      store[STORAGE_KEY] = JSON.stringify({
        constructor: { projectId: 'evil', sessionId: 'evil', directory: '/evil' },
        prototype: { projectId: 'evil', sessionId: 'evil', directory: '/evil' },
      });

      expect(readOpenCodeLastSelection('constructor')).toBeNull();
      expect(readOpenCodeLastSelection('prototype')).toBeNull();
    });
  });

  describe('security hardening (F3-2: credential stripping)', () => {
    it('strips user-info so credentialed URLs persist a credential-free key', () => {
      writeOpenCodeLastSelection('http://user:password@host-a:4196/', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });

      const raw = store[STORAGE_KEY];
      expect(raw).toBeDefined();
      expect(raw).not.toContain('user:password');
      expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });
    });

    it('drops query string and hash from the storage key', () => {
      writeOpenCodeLastSelection('http://host-a:4196/?token=secret#frag', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });

      const raw = store[STORAGE_KEY];
      expect(raw).toBeDefined();
      expect(raw).not.toContain('secret');
      expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });
    });

    it('reads a selection written via a credentialed URL back via the plain URL', () => {
      writeOpenCodeLastSelection('http://user:password@host-a:4196/?token=secret', {
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });

      expect(readOpenCodeLastSelection(SERVER_A)).toEqual({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        directory: '/repo/one',
      });
    });
  });
});
