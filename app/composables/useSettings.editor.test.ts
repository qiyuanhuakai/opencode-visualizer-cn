import { describe, expect, it } from 'vitest';

import { useSettingsTestHarness } from './useSettings.test-helpers';

describe('useSettings editor', () => {
  const harness = useSettingsTestHarness();

  it('persists editor preferences and local application path', async () => {
    const settings = await harness.importFresh();

    settings.editorFontSizePx.value = 16;
    settings.editorTabSize.value = 4;
    settings.editorShortcuts.value.moveLineUp = 'Alt-k';
    settings.localApplicationPath.value = ' /usr/bin/code ';

    expect(harness.storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('16');
    expect(harness.storage.getItem('opencode.settings.editorTabSize.v1')).toBe('4');
    expect(harness.storage.getItem('opencode.settings.editorShortcuts.v1')).toContain('Alt-k');
    expect(harness.storage.getItem('opencode.settings.localApplicationPath.v1')).toBe(
      '/usr/bin/code',
    );
  });

  it('treats persisted shortcut JSON as untrusted and preserves disabled bindings', async () => {
    harness.storage.setItem(
      'opencode.settings.editorShortcuts.v1',
      JSON.stringify({ indent: 42, outdent: '' }),
    );

    const settings = await harness.importFresh();

    expect(settings.editorShortcuts.value.indent).toBe('Tab');
    expect(settings.editorShortcuts.value.outdent).toBe('');
    settings.editorShortcuts.value.save = '';
    expect(harness.storage.getItem('opencode.settings.editorShortcuts.v1')).toContain('"save":""');
  });

  it('clears the editor font override to restore inherited sizing', async () => {
    const settings = await harness.importFresh();
    settings.editorFontSizePx.value = 16;
    expect(harness.storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('16');

    settings.editorFontSizePx.value = null;

    expect(harness.storage.getItem('opencode.settings.editorFontSizePx.v1')).toBeNull();
  });

  it('reads and writes showForgeButton setting', async () => {
    // Given: Forge is visible by default.
    const settings = await harness.importFresh();
    expect(settings.showForgeButton.value).toBe(true);

    // When: the user hides the Forge control.
    settings.showForgeButton.value = false;

    // Then: the preference is persisted for the next app load.
    expect(harness.storage.getItem('opencode.settings.showForgeButton.v1')).toBe('false');
  });

  it('reads and writes the Forge panel button setting', async () => {
    // Given: the Forge panel launcher is visible by default.
    const settings = await harness.importFresh();
    expect(settings.showForgePanelButton.value).toBe(true);

    // When: the user hides the Forge panel button from settings.
    settings.showForgePanelButton.value = false;

    // Then: the panel button preference is persisted like the Codex panel button.
    expect(harness.storage.getItem('opencode.settings.showForgePanelButton.v1')).toBe('false');
  });

  it('reacts to external storage events for the Forge panel button setting', async () => {
    // Given: another app window changes the Forge panel launcher preference.
    const settings = await harness.importFresh();
    const event = harness.storageEvent('opencode.settings.showForgePanelButton.v1', 'false');

    // When: the storage event reaches this window.
    for (const listener of harness.storageListeners) listener(event);

    // Then: this window hides the Forge panel button immediately.
    expect(settings.showForgePanelButton.value).toBe(false);
  });

  it('reacts to external storage events for showForgeButton', async () => {
    // Given: settings are open in another app window.
    const settings = await harness.importFresh();
    const event = harness.storageEvent('opencode.settings.showForgeButton.v1', 'false');

    // When: the other window changes the Forge visibility preference.
    for (const listener of harness.storageListeners) listener(event);

    // Then: this window hides the Forge control immediately.
    expect(settings.showForgeButton.value).toBe(false);
  });

  it('reacts to external storage events for editInVis', async () => {
    const settings = await harness.importFresh();
    const event = harness.storageEvent('opencode.settings.editInVis.v1', 'true');
    for (const listener of harness.storageListeners) listener(event);
    expect(settings.editInVis.value).toBe(true);
  });

  it('ignores untrusted prototype and unknown storage keys as no-ops', async () => {
    // Given: fresh settings with production defaults.
    const settings = await harness.importFresh();
    const before = {
      enterToSend: settings.enterToSend.value,
      suppressAutoWindows: settings.suppressAutoWindows.value,
      showMinimizeButtons: settings.showMinimizeButtons.value,
      showCodexButton: settings.showCodexButton.value,
      editInVis: settings.editInVis.value,
      dockAlwaysOpen: settings.dockAlwaysOpen.value,
      terminalFontFamily: settings.terminalFontFamily.value,
      terminalFontSizePx: settings.terminalFontSizePx.value,
      editorShortcuts: settings.editorShortcuts.value,
    };

    // When: storage events arrive for prototype-pollution and unknown keys.
    for (const key of ['__proto__', 'toString', 'constructor', 'opencode.settings.unknown.v1']) {
      for (const listener of harness.storageListeners) {
        listener(harness.storageEvent(key, 'true'));
      }
    }

    // Then: no setting changes and no prototype pollution occurs.
    expect(settings.enterToSend.value).toBe(before.enterToSend);
    expect(settings.suppressAutoWindows.value).toBe(before.suppressAutoWindows);
    expect(settings.showMinimizeButtons.value).toBe(before.showMinimizeButtons);
    expect(settings.showCodexButton.value).toBe(before.showCodexButton);
    expect(settings.editInVis.value).toBe(before.editInVis);
    expect(settings.dockAlwaysOpen.value).toBe(before.dockAlwaysOpen);
    expect(settings.terminalFontFamily.value).toBe(before.terminalFontFamily);
    expect(settings.terminalFontSizePx.value).toBe(before.terminalFontSizePx);
    expect(settings.editorShortcuts.value).toEqual(before.editorShortcuts);
    expect(({} as Record<string, unknown>).__proto__).toBe(Object.prototype);
  });

  it('resets dockAlwaysOpen when showMinimizeButtons is disabled', async () => {
    const settings = await harness.importFresh();
    settings.dockAlwaysOpen.value = true;
    settings.showMinimizeButtons.value = false;
    expect(settings.dockAlwaysOpen.value).toBe(false);
  });

  it('reacts to external storage events for font families', async () => {
    const settings = await harness.importFresh();
    const terminalEvent = harness.storageEvent(
      'opencode.settings.terminalFontFamily.v1',
      'External Terminal Font, monospace',
    );
    const appEvent = harness.storageEvent(
      'opencode.settings.appMonospaceFontFamily.v1',
      'External App Font, monospace',
    );
    for (const listener of harness.storageListeners) listener(terminalEvent);
    for (const listener of harness.storageListeners) listener(appEvent);
    expect(settings.terminalFontFamily.value).toBe('External Terminal Font, monospace');
    expect(settings.appMonospaceFontFamily.value).toBe('External App Font, monospace');
  });

  it('normalizes blank font family edits back to defaults', async () => {
    const settings = await harness.importFresh();
    settings.terminalFontFamily.value = '   ';
    settings.appMonospaceFontFamily.value = '';
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
    expect(harness.storage.getItem('opencode.settings.terminalFontFamily.v1')).toBe(
      settings.defaultTerminalFontFamily,
    );
    expect(harness.storage.getItem('opencode.settings.appMonospaceFontFamily.v1')).toBe(
      settings.defaultAppMonospaceFontFamily,
    );
  });

  it('uses default font families when storage event clears font keys', async () => {
    const settings = await harness.importFresh();
    const terminalEvent = harness.storageEvent('opencode.settings.terminalFontFamily.v1', null);
    const appEvent = harness.storageEvent('opencode.settings.appMonospaceFontFamily.v1', null);
    for (const listener of harness.storageListeners) listener(terminalEvent);
    for (const listener of harness.storageListeners) listener(appEvent);
    expect(settings.terminalFontFamily.value).toBe(settings.defaultTerminalFontFamily);
    expect(settings.appMonospaceFontFamily.value).toBe(settings.defaultAppMonospaceFontFamily);
  });

  it('does not auto-clamp openInEditorMaxSizeMb during editing', async () => {
    const settings = await harness.importFresh();
    settings.openInEditorMaxSizeMb.value = 0;
    expect(settings.openInEditorMaxSizeMb.value).toBe(0);
    expect(harness.storage.getItem('opencode.settings.openInEditorMaxSizeMb.v1')).toBe('0');
  });

  it('does not auto-clamp font size values during editing', async () => {
    const settings = await harness.importFresh();
    settings.terminalFontSizePx.value = 5;
    expect(settings.terminalFontSizePx.value).toBe(5);
    expect(harness.storage.getItem('opencode.settings.terminalFontSizePx.v1')).toBe('5');

    settings.appFontSizePx.value = 25;
    expect(settings.appFontSizePx.value).toBe(25);
    expect(harness.storage.getItem('opencode.settings.appFontSizePx.v1')).toBe('25');

    settings.editorFontSizePx.value = 1;
    expect(settings.editorFontSizePx.value).toBe(1);
    expect(harness.storage.getItem('opencode.settings.editorFontSizePx.v1')).toBe('1');
  });

  it('normalizes out-of-bounds font sizes from external storage events', async () => {
    const settings = await harness.importFresh();
    const terminalEvent = harness.storageEvent('opencode.settings.terminalFontSizePx.v1', '5');
    const appEvent = harness.storageEvent('opencode.settings.appFontSizePx.v1', '25');
    for (const listener of harness.storageListeners) listener(terminalEvent);
    for (const listener of harness.storageListeners) listener(appEvent);
    expect(settings.terminalFontSizePx.value).toBe(8);
    expect(settings.appFontSizePx.value).toBe(20);
  });

  it('writes back to localStorage when font size values change', async () => {
    const settings = await harness.importFresh();
    settings.terminalFontSizePx.value = 16;
    expect(harness.storage.getItem('opencode.settings.terminalFontSizePx.v1')).toBe('16');

    settings.appFontSizePx.value = 15;
    expect(harness.storage.getItem('opencode.settings.appFontSizePx.v1')).toBe('15');
  });

  it('reacts to external storage events for font sizes', async () => {
    const settings = await harness.importFresh();
    const terminalEvent = harness.storageEvent('opencode.settings.terminalFontSizePx.v1', '18');
    const appEvent = harness.storageEvent('opencode.settings.appFontSizePx.v1', '12');
    for (const listener of harness.storageListeners) listener(terminalEvent);
    for (const listener of harness.storageListeners) listener(appEvent);
    expect(settings.terminalFontSizePx.value).toBe(18);
    expect(settings.appFontSizePx.value).toBe(12);
  });

  it('persists and synchronizes sidebar font size independently from general UI text', async () => {
    harness.storage.setItem('opencode.settings.sidebarFontSizePx.v1', '14');
    const settings = await harness.importFresh();

    expect(settings.sidebarFontSizePx.value).toBe(14);
    expect(settings.uiFontSizePx.value).toBe(12);

    settings.sidebarFontSizePx.value = 16;
    expect(harness.storage.getItem('opencode.settings.sidebarFontSizePx.v1')).toBe('16');

    const event = harness.storageEvent('opencode.settings.sidebarFontSizePx.v1', '99');
    for (const listener of harness.storageListeners) listener(event);

    expect(settings.sidebarFontSizePx.value).toBe(20);
    expect(settings.uiFontSizePx.value).toBe(12);
  });

  it('uses default font sizes when storage event clears the keys', async () => {
    const settings = await harness.importFresh();
    const terminalEvent = harness.storageEvent('opencode.settings.terminalFontSizePx.v1', null);
    const appEvent = harness.storageEvent('opencode.settings.appFontSizePx.v1', null);
    const sidebarEvent = harness.storageEvent('opencode.settings.sidebarFontSizePx.v1', null);
    for (const listener of harness.storageListeners) listener(terminalEvent);
    for (const listener of harness.storageListeners) listener(appEvent);
    for (const listener of harness.storageListeners) listener(sidebarEvent);
    expect(settings.terminalFontSizePx.value).toBe(13);
    expect(settings.appFontSizePx.value).toBe(13);
    expect(settings.sidebarFontSizePx.value).toBe(12);
  });
});
