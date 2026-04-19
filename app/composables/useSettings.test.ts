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
    const settings = await importFresh();
    expect(settings.enterToSend.value).toBe(false);
    expect(settings.showMinimizeButtons.value).toBe(true);
    expect(settings.dockAlwaysOpen.value).toBe(false);
    expect(settings.pinnedSessionsLimit.value).toBe(30);
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
  });

  it('reads persisted values from storage on load', async () => {
    storage.setItem('opencode.settings.enterToSend.v1', 'true');
    storage.setItem('opencode.settings.showMinimizeButtons.v1', 'false');
    storage.setItem('opencode.settings.pinnedSessionsLimit.v1', '50');
    storage.setItem('opencode.settings.terminalFontFamily.v1', 'Test Terminal Font, monospace');
    storage.setItem('opencode.settings.appMonospaceFontFamily.v1', 'Test App Font, monospace');

    const settings = await importFresh();
    expect(settings.enterToSend.value).toBe(true);
    expect(settings.showMinimizeButtons.value).toBe(false);
    expect(settings.pinnedSessionsLimit.value).toBe(50);
    expect(settings.terminalFontFamily.value).toBe('Test Terminal Font, monospace');
    expect(settings.appMonospaceFontFamily.value).toBe('Test App Font, monospace');
  });

  it('writes back to localStorage when values change', async () => {
    const settings = await importFresh();
    settings.enterToSend.value = true;
    await new Promise((r) => setTimeout(r, 10));
    expect(storage.getItem('opencode.settings.enterToSend.v1')).toBe('true');
  });

  it('clamps pinnedSessionsLimit to max 200', async () => {
    const settings = await importFresh();
    settings.pinnedSessionsLimit.value = 300;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.pinnedSessionsLimit.value).toBe(200);
    expect(storage.getItem('opencode.settings.pinnedSessionsLimit.v1')).toBe('200');
  });

  it('clamps pinnedSessionsLimit to min 1', async () => {
    const settings = await importFresh();
    settings.pinnedSessionsLimit.value = 0;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.pinnedSessionsLimit.value).toBe(1);
    expect(storage.getItem('opencode.settings.pinnedSessionsLimit.v1')).toBe('1');
  });

  it('resets dockAlwaysOpen when showMinimizeButtons is disabled', async () => {
    const settings = await importFresh();
    settings.dockAlwaysOpen.value = true;
    await new Promise((r) => setTimeout(r, 10));
    settings.showMinimizeButtons.value = false;
    await new Promise((r) => setTimeout(r, 10));
    expect(settings.dockAlwaysOpen.value).toBe(false);
  });

  it('reacts to external storage events for pinnedSessionsLimit', async () => {
    const settings = await importFresh();
    const event = {
      key: 'opencode.settings.pinnedSessionsLimit.v1',
      newValue: '80',
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(event);
    expect(settings.pinnedSessionsLimit.value).toBe(80);
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

  it('uses default limit when storage event clears the key', async () => {
    const settings = await importFresh();
    const event = {
      key: 'opencode.settings.pinnedSessionsLimit.v1',
      newValue: null,
    } as unknown as StorageEvent;
    for (const listener of storageListeners) listener(event);
    expect(settings.pinnedSessionsLimit.value).toBe(30);
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
