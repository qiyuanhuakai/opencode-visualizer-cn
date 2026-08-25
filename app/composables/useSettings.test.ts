import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useSettings', () => {
  let storage: Storage;
  let storageListeners: Array<(event: StorageEvent) => void>;

  beforeEach(() => {
    vi.resetModules();
    storageListeners = [];
    const memStore = new Map<string, string>();

    storage = {
      getItem: (key) => memStore.get(key) ?? null,
      setItem: (key, value) => memStore.set(key, value),
      removeItem: (key) => memStore.delete(key),
      clear: () => memStore.clear(),
      key: (index) => Array.from(memStore.keys())[index] ?? null,
      get length() {
        return memStore.size;
      },
    } as Storage;

    const addEventListener = vi.fn((type: string, handler: EventListener) => {
      if (type === 'storage') storageListeners.push(handler as (event: StorageEvent) => void);
    });

    vi.stubGlobal('window', {
      localStorage: storage,
      addEventListener,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function importFresh() {
    const mod = await import('./useSettings');
    return mod.useSettings();
  }

  it('has correct defaults when storage is empty', async () => {
    // Given: no persisted user settings exist.
    const settings = await importFresh();

    // When: the shared settings singleton is initialized.
    // Then: Forge is visible by default because it only opens an optional PTY surface.
    expect(settings.enterToSend.value).toBe(false);
    expect(settings.showMinimizeButtons.value).toBe(true);
    expect(settings.showForgeButton.value).toBe(true);
    expect(settings.dockAlwaysOpen.value).toBe(false);
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
    expect(settings.terminalFontSizePx.value).toBe(13);
    expect(settings.appFontSizePx.value).toBe(13);
    expect(settings.sidebarFontSizePx.value).toBe(12);
    expect(settings.editorFontSizePx.value).toBeNull();
    expect(settings.editorTabSize.value).toBe(2);
    expect(settings.editorShortcuts.value.indent).toBe('Tab');
  });

  it('reads persisted values from storage on load', async () => {
    // Given: the user hid Forge and changed several unrelated settings.
    storage.setItem('opencode.settings.enterToSend.v1', 'true');
    storage.setItem('opencode.settings.showMinimizeButtons.v1', 'false');
    storage.setItem('opencode.settings.showForgeButton.v1', 'false');
    storage.setItem('opencode.settings.terminalFontFamily.v1', 'Test Terminal Font, monospace');
    storage.setItem('opencode.settings.appMonospaceFontFamily.v1', 'Test App Font, monospace');
    storage.setItem('opencode.settings.terminalFontSizePx.v1', '16');
    storage.setItem('opencode.settings.appFontSizePx.v1', '14');

    // When: settings are loaded from storage.
    const settings = await importFresh();

    // Then: the Forge visibility preference is restored with the rest of the settings.
    expect(settings.enterToSend.value).toBe(true);
    expect(settings.showMinimizeButtons.value).toBe(false);
    expect(settings.showForgeButton.value).toBe(false);
    expect(settings.terminalFontFamily.value).toBe('Test Terminal Font, monospace');
    expect(settings.appMonospaceFontFamily.value).toBe('Test App Font, monospace');
    expect(settings.terminalFontSizePx.value).toBe(16);
    expect(settings.appFontSizePx.value).toBe(14);
  });

  it('writes back to localStorage when values change', async () => {
    const settings = await importFresh();
    settings.enterToSend.value = true;
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.getItem('opencode.settings.enterToSend.v1')).toBe('true');
  });

  it('reads and writes editInVis setting', async () => {
    const settings = await importFresh();
    expect(settings.editInVis.value).toBe(false);

    settings.editInVis.value = true;
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.getItem('opencode.settings.editInVis.v1')).toBe('true');
  });

  it('persists boolean toggle settings to their exact sync storage keys', async () => {
    // Given: fresh settings with their production defaults on unset storage.
    const settings = await importFresh();
    expect(settings.suppressAutoWindows.value).toBe(false);
    expect(settings.showMinimizeButtons.value).toBe(true);
    expect(settings.showCodexButton.value).toBe(false);
    expect(settings.showCodexInStatusMonitor.value).toBe(true);

    // When: each toggle flips away from its default and the sync watch flushes.
    settings.suppressAutoWindows.value = true;
    settings.showMinimizeButtons.value = false;
    settings.showCodexButton.value = true;
    settings.showCodexInStatusMonitor.value = false;
    await new Promise((r) => setTimeout(r, 10));

    // Then: the flipped value is persisted to its exact storage key.
    expect(storage.getItem('opencode.settings.suppressAutoWindows.v1')).toBe('true');
    expect(storage.getItem('opencode.settings.showMinimizeButtons.v1')).toBe('false');
    expect(storage.getItem('opencode.settings.showCodexButton.v1')).toBe('true');
    expect(storage.getItem('opencode.settings.showCodexInStatusMonitor.v1')).toBe('false');
  });

  it('keeps text transformers disabled with no mappings by default', async () => {
    // Given: no text transformer settings have been persisted.
    const settings = await importFresh();

    // When: settings initialize.
    // Then: existing composer input behavior remains unchanged.
    expect(settings.textTransformersEnabled.value).toBe(false);
    expect(settings.textTransformers.value).toEqual([]);
  });

  it('persists and synchronizes normalized text transformer settings', async () => {
    // Given: storage contains enabled transformer settings with duplicate and malformed rows.
    storage.setItem('opencode.settings.textTransformersEnabled.v1', 'true');
    storage.setItem(
      'opencode.settings.textTransformers.v1',
      JSON.stringify([
        { trigger: String.raw`\hi`, replacement: 'first' },
        { trigger: 'hi', replacement: '你好' },
        { trigger: '/legacy-command', replacement: 'preserve me' },
        { trigger: 'bad key', replacement: 'ignored' },
      ]),
    );
    const settings = await importFresh();

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
    const migratedStorage = storage.getItem('opencode.settings.textTransformers.v1');
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
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformersEnabled.v1',
        newValue: 'false',
      } as unknown as StorageEvent);
    }

    // Then: edits are canonicalized in storage and the external toggle is applied immediately.
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
    const setItem = vi.spyOn(storage, 'setItem');
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
    const storedBeforeDraft = storage.getItem('opencode.settings.textTransformers.v1');

    // When: direct callers assign an invalid trigger and then a duplicate trigger.
    settings.textTransformers.value = [persisted[0]!, { ...persisted[1]!, trigger: 'has space' }];
    expect(settings.textTransformers.value).toEqual(persisted);
    settings.textTransformers.value = [persisted[0]!, { ...persisted[1]!, trigger: 'alpha' }];

    // Then: the shared runtime ref rolls back while the last valid persisted collection is untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(storedBeforeDraft);

    // When: another window persists a valid collection after those rejected assignments.
    const external = [{ ...persisted[0]!, name: 'External Alpha' }];
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(external));
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformers.v1',
        newValue: JSON.stringify(external),
      } as unknown as StorageEvent);
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
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(JSON.stringify(external));
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(original));
    const settings = await importFresh();
    const newer = [{ ...original[0]!, name: 'Newest committed value' }];
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(newer));

    // When: an older cross-window event arrives after the newer write is already authoritative.
    for (const listener of storageListeners) {
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
    storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: settings initialize from the untrusted persisted value.
    const settings = await importFresh();

    // Then: runtime stays valid, the raw recovery value remains untouched, and failure is observable.
    expect(settings.textTransformers.value).toEqual([]);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
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
    storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: settings initialize from the mixed collection.
    const settings = await importFresh();

    // Then: no lossy subset enters runtime or replaces the recoverable raw value.
    expect(settings.textTransformers.value).toEqual([]);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
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
    storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: startup parses the structurally valid collection.
    const settings = await importFresh();

    // Then: semantic validation rejects the whole collection before lossy normalization.
    expect(settings.textTransformers.value).toEqual([]);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
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
    storage.setItem('opencode.settings.textTransformers.v1', raw);

    // When: startup parses the duplicate collection.
    const settings = await importFresh();

    // Then: neither row is discarded or rewritten as a lossy subset.
    expect(settings.textTransformers.value).toEqual([]);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();

    // When: another window publishes malformed JSON at the same storage key.
    storage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformers.v1',
        newValue: 'not-json',
      } as unknown as StorageEvent);
    }

    // Then: the valid runtime state and malformed recovery value are both preserved.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
    storage.setItem('opencode.settings.textTransformers.v1', 'not-json');
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformers.v1',
        newValue: 'not-json',
      } as unknown as StorageEvent);
    }

    // When: a clean settings close reassigns an unchanged clone of the valid runtime library.
    settings.textTransformers.value = persisted.map((snippet) => ({ ...snippet, tags: [] }));

    // Then: the rejected raw payload remains recoverable and runtime rolls back to its valid snapshot.
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe('not-json');
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
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
    storage.setItem('opencode.settings.textTransformers.v1', mixedRaw);
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformers.v1',
        newValue: mixedRaw,
      } as unknown as StorageEvent);
    }

    // Then: valid runtime state remains authoritative and the raw recovery payload is untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(mixedRaw);
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
    const duplicates = [
      { ...persisted[0]!, id: 'snippet-external-first', trigger: 'external-duplicate' },
      { ...persisted[0]!, id: 'snippet-external-second', trigger: 'EXTERNAL-DUPLICATE' },
    ];
    const raw = JSON.stringify(duplicates);

    // When: another window publishes the duplicate current collection.
    storage.setItem('opencode.settings.textTransformers.v1', raw);
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.settings.textTransformers.v1',
        newValue: raw,
      } as unknown as StorageEvent);
    }

    // Then: the complete event is rejected and raw recovery data remains untouched.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(raw);
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
    storage.setItem('opencode.settings.textTransformers.v1', JSON.stringify(persisted));
    const settings = await importFresh();
    vi.spyOn(storage, 'setItem').mockImplementationOnce(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });

    // When: a nested array mutates through Vue's deep watcher.
    const mutableSnippet = settings.textTransformers.value[0]! as unknown as { tags: string[] };
    mutableSnippet.tags.push('unsaved');

    // Then: rollback restores an independent snapshot rather than the already-mutated alias.
    expect(settings.textTransformers.value).toEqual(persisted);
    expect(storage.getItem('opencode.settings.textTransformers.v1')).toBe(
      JSON.stringify(persisted),
    );
  });

  it('persists editor preferences and local application path', async () => {
    const settings = await importFresh();

    settings.editorFontSizePx.value = 16;
    settings.editorTabSize.value = 4;
    settings.editorShortcuts.value.moveLineUp = 'Alt-k';
    settings.localApplicationPath.value = ' /usr/bin/code ';

    expect(storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('16');
    expect(storage.getItem('opencode.settings.editorTabSize.v1')).toBe('4');
    expect(storage.getItem('opencode.settings.editorShortcuts.v1')).toContain('Alt-k');
    expect(storage.getItem('opencode.settings.localApplicationPath.v1')).toBe('/usr/bin/code');
  });

  it('treats persisted shortcut JSON as untrusted and preserves disabled bindings', async () => {
    storage.setItem(
      'opencode.settings.editorShortcuts.v1',
      JSON.stringify({ indent: 42, outdent: '' }),
    );

    const settings = await importFresh();

    expect(settings.editorShortcuts.value.indent).toBe('Tab');
    expect(settings.editorShortcuts.value.outdent).toBe('');
    settings.editorShortcuts.value.save = '';
    expect(storage.getItem('opencode.settings.editorShortcuts.v1')).toContain('"save":""');
  });

  it('clears the editor font override to restore inherited sizing', async () => {
    const settings = await importFresh();
    settings.editorFontSizePx.value = 16;
    expect(storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('16');

    settings.editorFontSizePx.value = null;

    expect(storage.getItem('opencode.settings.editorFontSizePx.v1')).toBeNull();
  });

  it('reads and writes showForgeButton setting', async () => {
    // Given: Forge is visible by default.
    const settings = await importFresh();
    expect(settings.showForgeButton.value).toBe(true);

    // When: the user hides the Forge control.
    settings.showForgeButton.value = false;
    await new Promise((r) => setTimeout(r, 10));

    // Then: the preference is persisted for the next app load.
    expect(storage.getItem('opencode.settings.showForgeButton.v1')).toBe('false');
  });

  it('reads and writes the Forge panel button setting', async () => {
    // Given: the Forge panel launcher is visible by default.
    const settings = await importFresh();
    expect(settings.showForgePanelButton.value).toBe(true);

    // When: the user hides the Forge panel button from settings.
    settings.showForgePanelButton.value = false;
    await new Promise((r) => setTimeout(r, 10));

    // Then: the panel button preference is persisted like the Codex panel button.
    expect(storage.getItem('opencode.settings.showForgePanelButton.v1')).toBe('false');
  });

  it('reacts to external storage events for the Forge panel button setting', async () => {
    // Given: another app window changes the Forge panel launcher preference.
    const settings = await importFresh();
    const event = {
      key: 'opencode.settings.showForgePanelButton.v1',
      newValue: 'false',
    } as unknown as StorageEvent;

    // When: the storage event reaches this window.
    for (const listener of storageListeners) listener(event);

    // Then: this window hides the Forge panel button immediately.
    expect(settings.showForgePanelButton.value).toBe(false);
  });

  it('reacts to external storage events for showForgeButton', async () => {
    // Given: settings are open in another app window.
    const settings = await importFresh();
    const event = {
      key: 'opencode.settings.showForgeButton.v1',
      newValue: 'false',
    } as unknown as StorageEvent;

    // When: the other window changes the Forge visibility preference.
    for (const listener of storageListeners) listener(event);

    // Then: this window hides the Forge control immediately.
    expect(settings.showForgeButton.value).toBe(false);
  });

  it('reacts to external storage events for editInVis', async () => {
    const settings = await importFresh();
    const event = {
      key: 'opencode.settings.editInVis.v1',
      newValue: 'true',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(event);
    expect(settings.editInVis.value).toBe(true);
  });

  it('ignores untrusted prototype and unknown storage keys as no-ops', async () => {
    // Given: fresh settings with production defaults.
    const settings = await importFresh();
    const before = {
      enterToSend: settings.enterToSend.value,
      suppressAutoWindows: settings.suppressAutoWindows.value,
      showMinimizeButtons: settings.showMinimizeButtons.value,
      showCodexButton: settings.showCodexButton.value,
      showCodexInStatusMonitor: settings.showCodexInStatusMonitor.value,
      editInVis: settings.editInVis.value,
      dockAlwaysOpen: settings.dockAlwaysOpen.value,
      terminalFontFamily: settings.terminalFontFamily.value,
      terminalFontSizePx: settings.terminalFontSizePx.value,
      editorShortcuts: settings.editorShortcuts.value,
    };

    // When: storage events arrive for prototype-pollution and unknown keys.
    for (const key of ['__proto__', 'toString', 'constructor', 'opencode.settings.unknown.v1']) {
      for (const listener of storageListeners) {
        listener({ key, newValue: 'true' } as unknown as StorageEvent);
      }
    }

    // Then: no setting changes and no prototype pollution occurs.
    expect(settings.enterToSend.value).toBe(before.enterToSend);
    expect(settings.suppressAutoWindows.value).toBe(before.suppressAutoWindows);
    expect(settings.showMinimizeButtons.value).toBe(before.showMinimizeButtons);
    expect(settings.showCodexButton.value).toBe(before.showCodexButton);
    expect(settings.showCodexInStatusMonitor.value).toBe(before.showCodexInStatusMonitor);
    expect(settings.editInVis.value).toBe(before.editInVis);
    expect(settings.dockAlwaysOpen.value).toBe(before.dockAlwaysOpen);
    expect(settings.terminalFontFamily.value).toBe(before.terminalFontFamily);
    expect(settings.terminalFontSizePx.value).toBe(before.terminalFontSizePx);
    expect(settings.editorShortcuts.value).toEqual(before.editorShortcuts);
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
  });

  it('resets dockAlwaysOpen when showMinimizeButtons is disabled', async () => {
    const settings = await importFresh();
    settings.dockAlwaysOpen.value = true;
    await new Promise((r) => setTimeout(r, 10));
    settings.showMinimizeButtons.value = false;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.dockAlwaysOpen.value).toBe(false);
  });

  it('reacts to external storage events for font families', async () => {
    const settings = await importFresh();
    const terminalEvent = {
      key: 'opencode.settings.terminalFontFamily.v1',
      newValue: 'External Terminal Font, monospace',
    } as unknown as StorageEvent;
    const appEvent = {
      key: 'opencode.settings.appMonospaceFontFamily.v1',
      newValue: 'External App Font, monospace',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(terminalEvent);
    for (const listener of storageListeners) listener(appEvent);
    expect(settings.terminalFontFamily.value).toBe('External Terminal Font, monospace');
    expect(settings.appMonospaceFontFamily.value).toBe('External App Font, monospace');
  });

  it('normalizes blank font family edits back to defaults', async () => {
    const settings = await importFresh();
    settings.terminalFontFamily.value = '   ';
    settings.appMonospaceFontFamily.value = '';
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
    expect(storage.getItem('opencode.settings.terminalFontFamily.v1')).toBe(
      settings.defaultTerminalFontFamily,
    );
    expect(storage.getItem('opencode.settings.appMonospaceFontFamily.v1')).toBe(
      settings.defaultAppMonospaceFontFamily,
    );
  });

  it('uses default font families when storage event clears font keys', async () => {
    const settings = await importFresh();
    const terminalEvent = {
      key: 'opencode.settings.terminalFontFamily.v1',
      newValue: null,
    } as unknown as StorageEvent;
    const appEvent = {
      key: 'opencode.settings.appMonospaceFontFamily.v1',
      newValue: null,
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(terminalEvent);
    for (const listener of storageListeners) listener(appEvent);
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
  });

  it('does not auto-clamp openInEditorMaxSizeMb during editing', async () => {
    const settings = await importFresh();
    settings.openInEditorMaxSizeMb.value = 0;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.openInEditorMaxSizeMb.value).toBe(0);
    expect(storage.getItem('opencode.settings.openInEditorMaxSizeMb.v1')).toBe('0');
  });

  it('does not auto-clamp font size values during editing', async () => {
    const settings = await importFresh();
    settings.terminalFontSizePx.value = 5;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.terminalFontSizePx.value).toBe(5);
    expect(storage.getItem('opencode.settings.terminalFontSizePx.v1')).toBe('5');

    settings.appFontSizePx.value = 25;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.appFontSizePx.value).toBe(25);
    expect(storage.getItem('opencode.settings.appFontSizePx.v1')).toBe('25');

    settings.editorFontSizePx.value = 1;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.editorFontSizePx.value).toBe(1);
    expect(storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('1');
  });

  it('normalizes out-of-bounds font sizes from external storage events', async () => {
    const settings = await importFresh();
    const terminalEvent = {
      key: 'opencode.settings.terminalFontSizePx.v1',
      newValue: '5',
    } as unknown as StorageEvent;
    const appEvent = {
      key: 'opencode.settings.appFontSizePx.v1',
      newValue: '25',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(terminalEvent);
    for (const listener of storageListeners) listener(appEvent);
    expect(settings.terminalFontSizePx.value).toBe(8);
    expect(settings.appFontSizePx.value).toBe(20);
  });

  it('writes back to localStorage when font size values change', async () => {
    const settings = await importFresh();
    settings.terminalFontSizePx.value = 16;
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.getItem('opencode.settings.terminalFontSizePx.v1')).toBe('16');

    settings.appFontSizePx.value = 15;
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.getItem('opencode.settings.appFontSizePx.v1')).toBe('15');
  });

  it('reacts to external storage events for font sizes', async () => {
    const settings = await importFresh();
    const terminalEvent = {
      key: 'opencode.settings.terminalFontSizePx.v1',
      newValue: '18',
    } as unknown as StorageEvent;
    const appEvent = {
      key: 'opencode.settings.appFontSizePx.v1',
      newValue: '12',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(terminalEvent);
    for (const listener of storageListeners) listener(appEvent);
    expect(settings.terminalFontSizePx.value).toBe(18);
    expect(settings.appFontSizePx.value).toBe(12);
  });

  it('persists and synchronizes sidebar font size independently from general UI text', async () => {
    storage.setItem('opencode.settings.sidebarFontSizePx.v1', '14');
    const settings = await importFresh();

    expect(settings.sidebarFontSizePx.value).toBe(14);
    expect(settings.uiFontSizePx.value).toBe(12);

    settings.sidebarFontSizePx.value = 16;
    expect(storage.getItem('opencode.settings.sidebarFontSizePx.v1')).toBe('16');

    const event = {
      key: 'opencode.settings.sidebarFontSizePx.v1',
      newValue: '99',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(event);

    expect(settings.sidebarFontSizePx.value).toBe(20);
    expect(settings.uiFontSizePx.value).toBe(12);
  });

  it('uses default font sizes when storage event clears the keys', async () => {
    const settings = await importFresh();
    const terminalEvent = {
      key: 'opencode.settings.terminalFontSizePx.v1',
      newValue: null,
    } as unknown as StorageEvent;
    const appEvent = {
      key: 'opencode.settings.appFontSizePx.v1',
      newValue: null,
    } as unknown as StorageEvent;
    const sidebarEvent = {
      key: 'opencode.settings.sidebarFontSizePx.v1',
      newValue: null,
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(terminalEvent);
    for (const listener of storageListeners) listener(appEvent);
    for (const listener of storageListeners) listener(sidebarEvent);
    expect(settings.terminalFontSizePx.value).toBe(13);
    expect(settings.appFontSizePx.value).toBe(13);
    expect(settings.sidebarFontSizePx.value).toBe(12);
  });

  it('persists and syncs external themes', async () => {
    const settings = await importFresh();
    settings.externalThemes.value = [
      {
        id: 'aurora',
        label: 'Aurora',
        badge: 'External',
        description: 'Northern-light inspired surfaces.',
        swatches: ['#08111f', '#11243b', '#67e8f9', '#eefbff'],
        regions: {
          topPanel: { bg: '#11243b' },
          sidePanel: { bg: '#0b1727' },
          inputPanel: { bg: '#0a1a2a' },
          outputPanel: { bg: '#0f2033' },
          topDropdown: { bg: '#0a1a2a' },
          modalPanel: { bg: '#11243b' },
          loginScreen: { bg: '#102033' },
          pageBackground: { bg: '#08111f' },
          chatCard: { bg: '#11243bb8' },
        },
      },
    ];
    await new Promise((r) => setTimeout(r, 10));

    expect(storage.getItem('opencode.settings.themeRegistry.v1')).toContain('aurora');

    const registryPayload = JSON.stringify({
      version: 1,
      themes: [
        {
          id: 'aurora-night',
          label: 'Aurora Night',
          regions: {
            topPanel: { bg: '#10192d' },
            sidePanel: { bg: '#0d1527' },
            inputPanel: { bg: '#0d1527' },
            outputPanel: { bg: '#122036' },
            topDropdown: { bg: '#0d1527' },
            modalPanel: { bg: '#122036' },
            loginScreen: { bg: '#10192d' },
            pageBackground: { bg: '#070d18' },
            chatCard: { bg: '#122036b8' },
          },
        },
      ],
    });
    storage.setItem('opencode.settings.themeRegistry.v1', registryPayload);

    const event = {
      key: 'opencode.settings.themeRegistry.v1',
      newValue: registryPayload,
    } as unknown as StorageEvent;

    for (const listener of storageListeners) listener(event);
    expect(settings.externalThemes.value).toHaveLength(1);
    expect(settings.externalThemes.value[0]?.id).toBe('aurora-night');
  });

  it('migrates legacy region theme storage into current theme tokens', async () => {
    storage.setItem(
      'opencode.settings.regionTheme.v1',
      JSON.stringify({
        name: 'aurora-legacy',
        label: 'Aurora Legacy',
        regions: {
          topPanel: { bg: '#11243b' },
          sidePanel: { bg: '#0b1727' },
          inputPanel: { bg: '#0a1a2a' },
          outputPanel: { bg: '#0f2033' },
          topDropdown: { bg: '#0a1a2a' },
          modalPanel: { bg: '#11243b' },
          loginScreen: { bg: '#102033' },
          pageBackground: { bg: '#08111f' },
          chatCard: { bg: '#11243bb8' },
        },
      }),
    );

    const settings = await importFresh();

    expect(settings.themeStorage.value?.version).toBe(2);
    expect(settings.themeStorage.value?.label).toBe('Aurora Legacy');
    expect(storage.getItem('opencode.settings.themeTokens.v2')).toContain('Aurora Legacy');
    expect(storage.getItem('opencode.settings.regionTheme.v1')).toBeNull();
  });
});
