import { describe, expect, it, vi } from 'vitest';

import { registerPersistentStorageIpc } from '../electron/persistentStorageIpc.js';

type IpcEvent = {
  readonly sender: { readonly id: number };
  returnValue: unknown;
};

type StorageChange = {
  readonly key: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
};

function createIpcFixture() {
  const handlers = new Map<string, (event: IpcEvent, payload: unknown) => void>();
  const values = new Map<string, string>([['opencode.saved', 'old']]);
  const pendingChanges: StorageChange[] = [];
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      const oldValue = values.get(key) ?? null;
      values.set(key, value);
      pendingChanges.push({ key, oldValue, newValue: value });
      return oldValue;
    }),
    removeItem: vi.fn((key: string) => {
      const oldValue = values.get(key) ?? null;
      values.delete(key);
      pendingChanges.push({ key, oldValue, newValue: null });
      return oldValue;
    }),
    migrate: vi.fn((entries: Record<string, string>) => {
      const changes: StorageChange[] = [];
      for (const [key, value] of Object.entries(entries)) {
        if (values.has(key)) continue;
        values.set(key, value);
        const change = { key, oldValue: null, newValue: value };
        changes.push(change);
        pendingChanges.push(change);
      }
      return changes;
    }),
    drainPendingChanges: vi.fn(() => pendingChanges.splice(0)),
  };
  const assertTrustedRenderer = vi.fn<(event: IpcEvent) => void>();
  const broadcastChange = vi.fn<(change: StorageChange, senderId?: number) => void>();

  registerPersistentStorageIpc({
    ipcMain: {
      on: (channel: string, handler: (event: IpcEvent, payload: unknown) => void) => {
        handlers.set(channel, handler);
      },
    },
    assertTrustedRenderer,
    getStorage: () => storage,
    broadcastChange,
    getLocalApplicationPath: () => '/Applications/Editor.app',
    localApplicationPathKey: 'opencode.settings.localApplicationPath.v1',
    rendererStoragePrefix: 'opencode.',
  });

  return { assertTrustedRenderer, broadcastChange, handlers, storage, values };
}

function invoke(
  handlers: ReadonlyMap<string, (event: IpcEvent, payload: unknown) => void>,
  channel: string,
  payload: unknown,
) {
  const event: IpcEvent = { sender: { id: 7 }, returnValue: undefined };
  const handler = handlers.get(channel);
  expect(handler).toBeDefined();
  handler?.(event, payload);
  return event;
}

describe('Electron persistent storage IPC', () => {
  it('registers get, set, remove, and migrate with their existing payloads and acknowledgements', () => {
    // Given: the production registration owns one native value and one protected local-app value.
    const fixture = createIpcFixture();

    // When: a trusted renderer invokes every registered storage channel.
    const get = invoke(fixture.handlers, 'persistent-storage-get', 'opencode.saved');
    const protectedGet = invoke(
      fixture.handlers,
      'persistent-storage-get',
      'opencode.settings.localApplicationPath.v1',
    );
    const set = invoke(fixture.handlers, 'persistent-storage-set', {
      key: 'opencode.saved',
      value: 'new',
    });
    const remove = invoke(fixture.handlers, 'persistent-storage-remove', 'opencode.saved');
    const migrate = invoke(fixture.handlers, 'persistent-storage-migrate', {
      'opencode.migrated': 'legacy',
    });

    // Then: the synchronous envelopes, boolean acknowledgements, and broadcasts are unchanged.
    expect(get.returnValue).toEqual({ ok: true, value: 'old' });
    expect(protectedGet.returnValue).toEqual({ ok: true, value: '/Applications/Editor.app' });
    expect(set.returnValue).toBe(true);
    expect(remove.returnValue).toBe(true);
    expect(migrate.returnValue).toBe(true);
    expect(fixture.broadcastChange.mock.calls).toEqual([
      [{ key: 'opencode.saved', oldValue: 'old', newValue: 'new' }, 7],
      [{ key: 'opencode.saved', oldValue: 'new', newValue: null }, 7],
      [{ key: 'opencode.migrated', oldValue: null, newValue: 'legacy' }, undefined],
    ]);
    expect(fixture.assertTrustedRenderer).toHaveBeenCalledTimes(5);
  });

  it('rejects an untrusted sender before reading payloads or touching storage', () => {
    // Given: sender trust validation rejects the IPC event.
    const fixture = createIpcFixture();
    const trustError = new Error('Untrusted renderer');
    fixture.assertTrustedRenderer.mockImplementation(() => {
      throw trustError;
    });
    const payload = Object.defineProperty({}, 'key', {
      get: vi.fn(() => 'opencode.saved'),
    });

    // When: the sender invokes the production set handler.
    const action = () => invoke(fixture.handlers, 'persistent-storage-set', payload);

    // Then: trust rejection escapes with no acknowledgement, mutation, or broadcast.
    expect(action).toThrow(trustError);
    expect(Object.getOwnPropertyDescriptor(payload, 'key')?.get).not.toHaveBeenCalled();
    expect(fixture.storage.setItem).not.toHaveBeenCalled();
    expect(fixture.broadcastChange).not.toHaveBeenCalled();
  });

  it('returns a failed acknowledgement without broadcasting when persistence fails', () => {
    // Given: the storage commit boundary rejects a remove operation.
    const fixture = createIpcFixture();
    fixture.storage.removeItem.mockImplementation(() => {
      throw new Error('injected rename failure');
    });

    // When: a trusted renderer requests that removal.
    const event = invoke(fixture.handlers, 'persistent-storage-remove', 'opencode.saved');

    // Then: failure is acknowledged without a success broadcast and the key remains.
    expect(event.returnValue).toBe(false);
    expect(fixture.broadcastChange).not.toHaveBeenCalled();
    expect(fixture.values.get('opencode.saved')).toBe('old');
  });

  it('returns a serializable failure envelope when storage loading fails', () => {
    // Given: native storage rejects malformed bytes during a synchronous read.
    const fixture = createIpcFixture();
    fixture.storage.getItem.mockImplementation(() => {
      throw Object.assign(new TypeError('invalid UTF-8'), { code: 'ERR_ENCODING' });
    });

    // When: a trusted renderer reads the malformed store.
    const event = invoke(fixture.handlers, 'persistent-storage-get', 'opencode.saved');

    // Then: sendSync receives the existing serializable error envelope.
    expect(event.returnValue).toEqual({
      ok: false,
      error: { name: 'TypeError', message: 'invalid UTF-8' },
    });
    expect(fixture.broadcastChange).not.toHaveBeenCalled();
  });
});
