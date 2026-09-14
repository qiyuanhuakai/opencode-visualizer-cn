import { describe, expect, it } from 'vitest';

import { useSettingsTestHarness } from './useSettings.test-helpers';

describe('useSettings persistence', () => {
  const harness = useSettingsTestHarness();

  it('has correct defaults when storage is empty', async () => {
    // Given: no persisted user settings exist.
    const settings = await harness.importFresh();

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
    harness.storage.setItem('opencode.settings.enterToSend.v1', 'true');
    harness.storage.setItem('opencode.settings.showMinimizeButtons.v1', 'false');
    harness.storage.setItem('opencode.settings.showForgeButton.v1', 'false');
    harness.storage.setItem(
      'opencode.settings.terminalFontFamily.v1',
      'Test Terminal Font, monospace',
    );
    harness.storage.setItem(
      'opencode.settings.appMonospaceFontFamily.v1',
      'Test App Font, monospace',
    );
    harness.storage.setItem('opencode.settings.terminalFontSizePx.v1', '16');
    harness.storage.setItem('opencode.settings.appFontSizePx.v1', '14');

    // When: settings are loaded from storage.
    const settings = await harness.importFresh();

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
    const settings = await harness.importFresh();
    settings.enterToSend.value = true;
    expect(harness.storage.getItem('opencode.settings.enterToSend.v1')).toBe('true');
  });

  it('reads and writes editInVis setting', async () => {
    const settings = await harness.importFresh();
    expect(settings.editInVis.value).toBe(false);

    settings.editInVis.value = true;
    expect(harness.storage.getItem('opencode.settings.editInVis.v1')).toBe('true');
  });

  it('persists boolean toggle settings to their exact sync storage keys', async () => {
    // Given: fresh settings with their production defaults on unset storage.
    const settings = await harness.importFresh();
    expect(settings.suppressAutoWindows.value).toBe(false);
    expect(settings.showMinimizeButtons.value).toBe(true);
    expect(settings.showCodexButton.value).toBe(false);
    expect(settings.showCodexInStatusMonitor.value).toBe(true);

    // When: each toggle flips away from its default and the sync watch flushes.
    settings.suppressAutoWindows.value = true;
    settings.showMinimizeButtons.value = false;
    settings.showCodexButton.value = true;
    settings.showCodexInStatusMonitor.value = false;

    // Then: the flipped value is persisted to its exact storage key.
    expect(harness.storage.getItem('opencode.settings.suppressAutoWindows.v1')).toBe('true');
    expect(harness.storage.getItem('opencode.settings.showMinimizeButtons.v1')).toBe('false');
    expect(harness.storage.getItem('opencode.settings.showCodexButton.v1')).toBe('true');
    expect(harness.storage.getItem('opencode.settings.showCodexInStatusMonitor.v1')).toBe('false');
  });
});
