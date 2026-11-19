import { describe, expect, it } from 'vitest';

import { useSettingsTestHarness } from './useSettings.test-helpers';
import { encodeLiveSetting, liveSettingKey } from '../../shared/runtime/liveSettings.js';

describe('useSettings themes', () => {
  const harness = useSettingsTestHarness();

  it('applies a live event and ignores a stale event after a removal', async () => {
    harness.storage.setItem('opencode.settings.enterToSend.v1', 'true');
    const settings = await harness.importFresh();
    const key = liveSettingKey('settings.enterToSend.v1');
    harness.storage.setItem(key, encodeLiveSetting(null));
    for (const listener of harness.storageListeners) listener(harness.storageEvent(key, encodeLiveSetting(null)));
    expect(settings.enterToSend.value).toBe(false);
    for (const listener of harness.storageListeners) {
      listener(harness.storageEvent('opencode.settings.enterToSend.v1', 'true'));
    }
    expect(settings.enterToSend.value).toBe(false);
    expect(harness.storage.getItem('opencode.settings.enterToSend.v1')).toBe('true');
  });

  it('applies live event string and theme values without accepting corrupt envelopes', async () => {
    const settings = await harness.importFresh();
    const fontKey = liveSettingKey('settings.terminalFontFamily.v1');
    harness.storage.setItem(fontKey, encodeLiveSetting('Peer Font'));
    for (const listener of harness.storageListeners) listener(harness.storageEvent(fontKey, encodeLiveSetting('Peer Font')));
    expect(settings.terminalFontFamily.value).toBe('Peer Font');
    const themeKey = liveSettingKey('settings.themeTokens.v2');
    const theme = JSON.stringify({ version: 2, preset: 'soft-white', label: 'Peer Light', overrides: {} });
    harness.storage.setItem(themeKey, encodeLiveSetting(theme));
    for (const listener of harness.storageListeners) listener(harness.storageEvent(themeKey, encodeLiveSetting(theme)));
    expect(settings.themeStorage.value?.preset).toBe('soft-white');
    harness.storage.setItem(themeKey, '{');
    for (const listener of harness.storageListeners) listener(harness.storageEvent(themeKey, '{'));
    expect(settings.themeStorage.value?.preset).toBe('soft-white');
  });

  it('persists and syncs external themes', async () => {
    const settings = await harness.importFresh();
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

    expect(harness.readSetting('opencode.settings.themeRegistry.v1')).toContain('aurora');

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
    harness.storage.setItem('opencode.settings.themeRegistry.v1', registryPayload);

    const event = harness.peerSetting('opencode.settings.themeRegistry.v1', registryPayload);

    for (const listener of harness.storageListeners) listener(event);
    expect(settings.externalThemes.value).toHaveLength(1);
    expect(settings.externalThemes.value[0]?.id).toBe('aurora-night');
  });

  it('migrates legacy region theme storage into current theme tokens', async () => {
    harness.storage.setItem(
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

    const settings = await harness.importFresh();

    expect(settings.themeStorage.value?.version).toBe(2);
    expect(settings.themeStorage.value?.label).toBe('Aurora Legacy');
    expect(harness.readSetting('opencode.settings.themeTokens.v2')).toContain('Aurora Legacy');
    expect(harness.readSetting('opencode.settings.regionTheme.v1')).toBeNull();
    expect(harness.storage.getItem('opencode.settings.regionTheme.v1')).toContain('Aurora Legacy');
    expect(harness.storage.getItem('opencode.settings.themeTokens.v2')).toBeNull();
  });

  it.each([
    ['ocean', 'aurora-tide'],
    ['forest', 'violet-nocturne'],
  ])('replaces retired %s preset with %s on load', async (oldPreset, newPreset) => {
    harness.storage.setItem('opencode.settings.themeTokens.v2', JSON.stringify({
      version: 2,
      preset: oldPreset,
      label: oldPreset,
      overrides: {},
    }));

    const settings = await harness.importFresh();
    expect(settings.themeStorage.value?.preset).toBe(newPreset);
    expect(JSON.parse(harness.readSetting('opencode.settings.themeTokens.v2') ?? '{}').preset).toBe(newPreset);
    expect(JSON.parse(harness.storage.getItem('opencode.settings.themeTokens.v2') ?? '{}').preset).toBe(oldPreset);
  });

  it('preserves a customized imported theme when its id becomes built in', async () => {
    harness.storage.setItem('opencode.settings.themeRegistry.v1', JSON.stringify({
      version: 1,
      themes: [{
        id: 'anime-dream',
        label: 'My Anime Dream',
        regions: { topPanel: { bg: '#aabbcc' } },
      }],
    }));
    harness.storage.setItem('opencode.settings.themeTokens.v2', JSON.stringify({
      version: 2,
      preset: 'anime-dream',
      label: 'My Anime Dream',
      overrides: { 'region-top-bg': '#aabbcc' },
    }));

    const settings = await harness.importFresh();

    expect(settings.externalThemes.value[0]?.id).toBe('anime-dream-imported');
    expect(settings.externalThemes.value[0]?.regions.topPanel.bg).toBe('#aabbcc');
    expect(settings.themeStorage.value?.preset).toBe('anime-dream-imported');
    expect(harness.readSetting('opencode.settings.themeRegistry.v1')).toContain('anime-dream-imported');
  });
});
