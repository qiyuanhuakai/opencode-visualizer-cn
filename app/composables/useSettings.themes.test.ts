import { describe, expect, it } from 'vitest';

import { useSettingsTestHarness } from './useSettings.test-helpers';

describe('useSettings themes', () => {
  const harness = useSettingsTestHarness();

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

    expect(harness.storage.getItem('opencode.settings.themeRegistry.v1')).toContain('aurora');

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

    const event = harness.storageEvent('opencode.settings.themeRegistry.v1', registryPayload);

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
    expect(harness.storage.getItem('opencode.settings.themeTokens.v2')).toContain('Aurora Legacy');
    expect(harness.storage.getItem('opencode.settings.regionTheme.v1')).toBeNull();
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
    expect(JSON.parse(harness.storage.getItem('opencode.settings.themeTokens.v2') ?? '{}').preset).toBe(newPreset);
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
    expect(harness.storage.getItem('opencode.settings.themeRegistry.v1')).toContain('anime-dream-imported');
  });
});
