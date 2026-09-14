import { describe, expect, it, vi } from 'vitest';

import { useSettingsTestHarness } from './useSettings.test-helpers';

describe('useSettings snippets', () => {
  const harness = useSettingsTestHarness();

  it('keeps text transformers disabled with no mappings by default', async () => {
    // Given: no text transformer settings have been persisted.
    const settings = await harness.importFresh();

    // When: settings initialize.
    // Then: existing composer input behavior remains unchanged.
    expect(settings.textTransformersEnabled.value).toBe(false);
    expect(settings.textTransformers.value).toEqual([]);
  });

  it('persists and synchronizes normalized text transformer settings', async () => {
    // Given: storage contains enabled transformer settings with duplicate and malformed rows.
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'true');
    harness.storage.setItem(
      'opencode.settings.textTransformers.v1',
      JSON.stringify([
        { trigger: String.raw`\hi`, replacement: 'first' },
        { trigger: 'hi', replacement: '你好' },
        { trigger: '/legacy-command', replacement: 'preserve me' },
        { trigger: 'bad key', replacement: 'ignored' },
      ]),
    );
    const settings = await harness.importFresh();

    // When: a mapping is edited and another window disables the feature.
    expect(settings.textTransformersEnabled.value).toBe(true);
    expect(settings.textTransformers.value).toEqual([
      {
        id: settings.textTransformers.value[0]?.id,
        trigger: 'hi',
        name: 'hi',
        body: '你好',
        enabled: true,
        tags: [],
      },
      {
        id: settings.textTransformers.value[1]?.id,
        trigger: '/legacy-command',
        name: '/legacy-command',
        body: 'preserve me',
        enabled: false,
        tags: [],
      },
    ]);
    const migratedStorage = harness.storage.getItem('opencode.settings.textTransformers.v1');
    expect(migratedStorage).toBe(JSON.stringify(settings.textTransformers.value));
    settings.textTransformers.value = [
      {
        id: 'snippet-never',
        trigger: 'never',
        name: 'Never do this',
        body: '千万不要这样做',
        enabled: true,
        tags: ['Guardrail'],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'false');
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.textTransformersEnabled.v1', 'false'));
    }

    // Then: edits are canonicalized in storage and the external toggle is applied immediately.
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      JSON.stringify(settings.textTransformers.value),
    );
    expect(settings.textTransformersEnabled.value).toBe(false);
  });

  it('restores the last persisted snippet state when storage rejects a write', async () => {
    // Given: one persisted snippet is loaded and the next two storage writes will fail.
    const persisted = [
      {
        id: 'snippet-persisted',
        trigger: 'saved',
        name: 'Saved',
        body: 'Saved body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    const setItem = vi.spyOn(harness.storage, 'setItem');
    setItem.mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // When: a replacement library and then the global enable flag fail to persist.
    settings.textTransformers.value = [{ ...persisted[0]!, name: 'Unsaved' }];
    setItem.mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    settings.textTransformersEnabled.value = true;

    // Then: both refs roll back synchronously and expose two observable persistence failures.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(settings.textTransformersEnabled.value).toBe(false);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(2);
  });

  it('retries a same-value Snippet write after a false native acknowledgement', async () => {
    // Given: native storage commits a changed library but its first durability acknowledgement fails.
    const key = 'opencode.settings.textTransformers.v1';
    const persisted = [
      {
        id: 'snippet-retry',
        trigger: 'retry',
        name: 'Before',
        body: 'Body',
        enabled: true,
        tags: [],
      },
    ];
    const nativeStore: Record<string, string> = { [key]: JSON.stringify(persisted) };
    let rejectAcknowledgement = true;
    const setItem = vi.fn((storageKey: string, value: string) => {
      nativeStore[storageKey] = value;
      if (!rejectAcknowledgement) return true;
      rejectAcknowledgement = false;
      return false;
    });
    vi.stubGlobal('window', {
      localStorage: harness.storage,
      addEventListener: vi.fn(),
      electronAPI: {
        persistentStorage: {
          getItem: (storageKey: string) => nativeStore[storageKey] ?? null,
          setItem,
          removeItem: vi.fn(() => true),
          migrate: vi.fn(() => true),
        },
      },
    });
    const settings = await harness.importFresh();
    const changed = persisted.map((snippet) => ({ ...snippet, name: 'After' }));

    // When: the row retries the identical edit after the optimistic state rolled back.
    settings.textTransformers.value = changed;
    expect(settings.textTransformers.value).toEqual(persisted);
    settings.textTransformers.value = changed;

    // Then: the retry reaches native storage again before the persistence error can clear.
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(settings.textTransformers.value).toEqual(changed);
    expect(Reflect.get(settings, 'textTransformerPersistenceSuccessRevision')?.value).toBe(1);
  });

  it('keeps the shared snippet state within the complete persistence contract', async () => {
    // Given: two distinct valid snippets are persisted.
    const persisted = [
      {
        id: 'snippet-alpha',
        trigger: 'alpha',
        name: 'Alpha',
        body: 'Alpha body',
        enabled: true,
        tags: [],
      },
      {
        id: 'snippet-beta',
        trigger: 'beta',
        name: 'Beta',
        body: 'Beta body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    const storedBeforeDraft = harness.storage.getItem('opencode.settings.textTransformers.v1');

    // When: direct callers assign an invalid trigger and then a duplicate trigger.
    settings.textTransformers.value = [persisted[0]!, { ...persisted[1]!, trigger: 'has space' }];
    expect(settings.textTransformers.value).toEqual(persisted);
    settings.textTransformers.value = [persisted[0]!, { ...persisted[1]!, trigger: 'alpha' }];

    // Then: the shared runtime ref rolls back while the last valid persisted collection is untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      storedBeforeDraft,
    );

    // When: another window persists a valid collection after those rejected assignments.
    const external = [{ ...persisted[0]!, name: 'External Alpha' }];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(external));
    for (const listener of harness.storageListeners) {
      listener(
        harness.storageEvent('opencode.settings.textTransformers.v1', JSON.stringify(external)),
      );
    }

    // Then: the external valid collection becomes authoritative immediately.
    expect(settings.textTransformers.value).toEqual(external);

    // When: a complete library exceeds the public five MiB backup budget.
    const excessive = Array.from({ length: 6 }, (_, index) => ({
      ...persisted[0]!,
      id: `snippet-large-${index}`,
      trigger: `large-${index}`,
      body: '界'.repeat(300_000),
    }));
    settings.textTransformers.value = excessive;

    // Then: it also rolls back before storage or runtime can accept an unexportable collection.
    expect(settings.textTransformers.value).toEqual(external);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      JSON.stringify(external),
    );
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(3);
  });

  it('ignores a delayed snippet event after newer storage has committed', async () => {
    // Given: runtime and storage start from the same Snippet library.
    const original = [
      {
        id: 'snippet-event-order',
        trigger: 'event-order',
        name: 'Original',
        body: 'Original body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(original));
    const settings = await harness.importFresh();
    const newer = [{ ...original[0]!, name: 'Newest committed value' }];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(newer));

    // When: an older cross-window event arrives after the newer write is already authoritative.
    for (const listener of harness.storageListeners) {
      listener(
        new StorageEvent('storage', {
          key: 'opencode.settings.textTransformers.v1',
          newValue: JSON.stringify(original),
        }),
      );
    }

    // Then: the handler reloads canonical storage instead of reverting runtime to the stale event.
    expect(settings.textTransformers.value).toEqual(newer);
  });

  it('keeps the last valid snippet library when canonical storage temporarily fails to read', async () => {
    // Given: one valid Snippet library is active and the next canonical read will fail.
    const persisted = [
      {
        id: 'snippet-read-error',
        trigger: 'read-error',
        name: 'Read error guard',
        body: 'Keep this library',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    const getItem = vi.spyOn(harness.storage, 'getItem').mockImplementationOnce(() => {
      throw new DOMException('Storage unavailable', 'InvalidStateError');
    });

    // When: a cross-window signal asks this window to reload during the failed read.
    for (const listener of harness.storageListeners) {
      listener(
        new StorageEvent('storage', {
          key: 'opencode.settings.textTransformers.v1',
          newValue: JSON.stringify([]),
        }),
      );
    }
    getItem.mockRestore();

    // Then: the error is observable without being reinterpreted as an empty library.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      JSON.stringify(persisted),
    );
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('ignores a delayed snippet-enabled event after newer storage has committed', async () => {
    // Given: runtime and canonical storage both start with Snippets disabled.
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'false');
    const settings = await harness.importFresh();
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'true');

    // When: an older disable event arrives after the newer enable write is authoritative.
    for (const listener of harness.storageListeners) {
      listener(
        new StorageEvent('storage', {
          key: 'opencode.settings.textTransformersEnabled.v1',
          newValue: 'false',
        }),
      );
    }

    // Then: runtime follows canonical storage rather than the stale event payload.
    expect(settings.textTransformersEnabled.value).toBe(true);
  });

  it('keeps enabled state unchanged when canonical storage temporarily fails to read', async () => {
    // Given: runtime and canonical storage both contain the newer enabled value.
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'false');
    const settings = await harness.importFresh();
    harness.storage.setItem('opencode.settings.textTransformersEnabled.v1', 'true');
    settings.textTransformersEnabled.value = true;
    const getItem = vi.spyOn(harness.storage, 'getItem');
    getItem.mockImplementationOnce(() => {
      throw new DOMException('Storage unavailable', 'InvalidStateError');
    });

    // When: an older disable event arrives during one transient canonical read failure.
    for (const listener of harness.storageListeners) {
      listener(
        new StorageEvent('storage', {
          key: 'opencode.settings.textTransformersEnabled.v1',
          newValue: 'false',
        }),
      );
    }
    getItem.mockRestore();

    // Then: the failed read leaves both runtime and canonical storage untouched.
    expect(settings.textTransformersEnabled.value).toBe(true);
    expect(harness.storage.getItem('opencode.settings.textTransformersEnabled.v1')).toBe('true');
  });

  it('rejects over-limit snippet storage at startup without destroying the raw backup', async () => {
    // Given: persisted storage contains 1,001 individually valid snippets.
    const excessive = Array.from({ length: 1_001 }, (_, index) => ({
      id: `startup-${index}`,
      trigger: `startup-${index}`,
      name: `Startup ${index}`,
      body: 'Body',
      enabled: true,
      tags: [],
    }));
    const raw = JSON.stringify(excessive);
    harness.storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: settings initialize from the untrusted persisted value.
    const settings = await harness.importFresh();

    // Then: runtime stays valid, the raw recovery value remains untouched, and failure is observable.
    expect(settings.textTransformers.value).toEqual([]);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('rejects mixed valid and malformed startup rows without salvaging a lossy subset', async () => {
    // Given: storage contains one valid row and one malformed row whose body is missing.
    const mixed = [
      {
        id: 'snippet-safe-startup',
        trigger: 'safe-startup',
        name: 'Safe startup',
        body: 'Keep',
        enabled: true,
        tags: [],
      },
      {
        id: 'snippet-recover-startup',
        trigger: 'recover-startup',
        name: 'Recover startup',
        enabled: true,
        tags: [],
      },
    ];
    const raw = JSON.stringify(mixed);
    harness.storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: settings initialize from the mixed collection.
    const settings = await harness.importFresh();

    // Then: no lossy subset enters runtime or replaces the recoverable raw value.
    expect(settings.textTransformers.value).toEqual([]);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('rejects semantically invalid current triggers before startup normalization', async () => {
    // Given: every current field has the right type, but one trigger contains whitespace.
    const mixed = [
      {
        id: 'snippet-safe-semantic',
        trigger: 'safe-semantic',
        name: 'Safe semantic',
        body: 'Keep',
        enabled: true,
        tags: [],
      },
      {
        id: 'snippet-recover-semantic',
        trigger: 'has space',
        name: 'Recover semantic',
        body: 'Recover',
        enabled: true,
        tags: [],
      },
    ];
    const raw = JSON.stringify(mixed);
    harness.storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: startup parses the structurally valid collection.
    const settings = await harness.importFresh();

    // Then: semantic validation rejects the whole collection before lossy normalization.
    expect(settings.textTransformers.value).toEqual([]);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('rejects duplicate current triggers before startup collection normalization', async () => {
    // Given: two fully valid current rows have case-fold-equivalent triggers.
    const duplicates = [
      {
        id: 'snippet-duplicate-first',
        trigger: 'duplicate',
        name: 'Duplicate first',
        body: 'Recover first',
        enabled: true,
        tags: [],
      },
      {
        id: 'snippet-duplicate-second',
        trigger: 'DUPLICATE',
        name: 'Duplicate second',
        body: 'Keep second',
        enabled: true,
        tags: [],
      },
    ];
    const raw = JSON.stringify(duplicates);
    harness.storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: startup parses the duplicate collection.
    const settings = await harness.importFresh();

    // Then: neither row is discarded or rewritten as a lossy subset.
    expect(settings.textTransformers.value).toEqual([]);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('rejects malformed external snippet storage without erasing valid state', async () => {
    // Given: one valid persisted snippet is active in this window.
    const persisted = [
      {
        id: 'snippet-safe',
        trigger: 'safe',
        name: 'Safe',
        body: 'Safe body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();

    // When: another window publishes malformed JSON at the same storage key.
    harness.storage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.textTransformers.v1', 'not-json'));
    }

    // Then: the valid runtime state and malformed recovery value are both preserved.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('keeps rejected external recovery data through an unchanged local commit', async () => {
    // Given: valid runtime state has rejected a malformed value published by another window.
    const persisted = [
      {
        id: 'snippet-recovery-latch',
        trigger: 'recovery-latch',
        name: 'Recovery latch',
        body: 'Keep',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    harness.storage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.textTransformers.v1', 'not-json'));
    }

    // When: a clean settings close reassigns an unchanged clone of the valid runtime library.
    settings.textTransformers.value = persisted.map((snippet) => ({ ...snippet, tags: [] }));

    // Then: the rejected raw payload remains recoverable and runtime rolls back to its valid snapshot.
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(2);
  });

  it('rejects structurally malformed external rows without salvaging their valid siblings', async () => {
    // Given: this window holds one valid authoritative snippet.
    const persisted = [
      {
        id: 'snippet-safe-external',
        trigger: 'safe-external',
        name: 'Safe external',
        body: 'Safe body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    const mixedRaw = JSON.stringify([
      persisted[0],
      {
        id: 'snippet-recover-external',
        trigger: 'recover-external',
        name: 'Recover external',
        body: 'Recover body',
        enabled: 'false',
        tags: [],
      },
    ]);

    // When: an external event publishes the mixed collection.
    harness.storage.setItem('opencode.settings.textTransformers.v1', mixedRaw);
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.textTransformers.v1', mixedRaw));
    }

    // Then: valid runtime state remains authoritative and the raw recovery payload is untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(mixedRaw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('rejects duplicate current triggers from external storage as one atomic collection', async () => {
    // Given: this window has a valid authoritative row.
    const persisted = [
      {
        id: 'snippet-external-authoritative',
        trigger: 'authoritative',
        name: 'Authoritative',
        body: 'Keep',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    const duplicates = [
      { ...persisted[0]!, id: 'snippet-external-first', trigger: 'external-duplicate' },
      { ...persisted[0]!, id: 'snippet-external-second', trigger: 'EXTERNAL-DUPLICATE' },
    ];
    const raw = JSON.stringify(duplicates);

    // When: another window publishes the duplicate current collection.
    harness.storage.setItem('opencode.settings.textTransformers.v1', raw);
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.textTransformers.v1', raw));
    }

    // Then: the complete event is rejected and raw recovery data remains untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
    expect(Reflect.get(settings, 'textTransformerPersistenceErrorRevision')?.value).toBe(1);
  });

  it('keeps a detached rollback snapshot when deep mutations fail to persist', async () => {
    // Given: one valid snippet has been loaded and the next write will fail.
    const persisted = [
      {
        id: 'snippet-snapshot',
        trigger: 'snapshot',
        name: 'Snapshot',
        body: 'Snapshot body',
        enabled: true,
        tags: [],
      },
    ];
    harness.storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await harness.importFresh();
    vi.spyOn(harness.storage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // When: a nested array mutates through Vue's deep watcher.
    const mutableSnippet = settings.textTransformers.value[0];
    if (!mutableSnippet) throw new Error('Expected persisted snippet');
    Array.prototype.push.call(mutableSnippet.tags, 'unsaved');

    // Then: rollback restores an independent snapshot rather than the already-mutated alias.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(harness.storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      JSON.stringify(persisted),
    );
  });
});
