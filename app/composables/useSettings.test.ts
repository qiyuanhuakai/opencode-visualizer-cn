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
    storage.setItem('opencode.settings.editorShortcuts.v1', JSON.stringify({ indent: 42, outdent: '' }));

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
    expect(storage.getItem('opencode.settings.terminalFontFamily.v1')).toBe(settings.defaultTerminalFontFamily);
    expect(storage.getItem('opencode.settings.appMonospaceFontFamily.v1')).toBe(settings.defaultAppMonospaceFontFamily);
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
