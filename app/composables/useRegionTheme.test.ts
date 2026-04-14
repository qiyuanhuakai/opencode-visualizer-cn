import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';

import { OCEAN_PRESET } from '../utils/regionTheme';
import { StorageKeys, storageKey } from '../utils/storageKeys';
import {
  DEFAULT_SYNTAX_THEME,
  SEMANTIC_THEME_TOKENS,
  createSemanticTokenSnapshot,
  regionThemeToSemanticOverrides,
  semanticTokenCssVariable,
} from '../utils/themeTokens';

describe('useRegionTheme', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.localStorage.clear();
    document.getElementById('region-theme-compat')?.remove();
    document.documentElement.removeAttribute('data-region-theme');
    document.documentElement.removeAttribute('data-theme-custom');
    document.documentElement.style.removeProperty('--syntax-theme-name');
    for (const token of SEMANTIC_THEME_TOKENS) {
      document.documentElement.style.removeProperty(semanticTokenCssVariable(token));
    }
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.getElementById('region-theme-compat')?.remove();
    document.documentElement.removeAttribute('data-region-theme');
    document.documentElement.removeAttribute('data-theme-custom');
    document.documentElement.style.removeProperty('--syntax-theme-name');
    for (const token of SEMANTIC_THEME_TOKENS) {
      document.documentElement.style.removeProperty(semanticTokenCssVariable(token));
    }
    document.body.innerHTML = '';
  });

  async function mountComposable() {
    let api!: Awaited<typeof import('./useRegionTheme')>['useRegionTheme'] extends (...args: never[]) => infer T ? T : never;

    const { useRegionTheme } = await import('./useRegionTheme');
    const root = document.createElement('div');
    document.body.appendChild(root);

    const app = createApp(
      defineComponent({
        setup() {
          api = useRegionTheme();
          return () => null;
        },
      }),
    );

    app.mount(root);
    await nextTick();

    return {
      api,
      unmount() {
        app.unmount();
        root.remove();
      },
    };
  }

  it('installs compatibility css and syncs semantic tokens for custom themes', async () => {
    const { api, unmount } = await mountComposable();

    const compatTag = document.getElementById('region-theme-compat');
    expect(compatTag).toBeInstanceOf(HTMLStyleElement);
    expect(document.documentElement.style.getPropertyValue('--syntax-theme-name')).toBe(DEFAULT_SYNTAX_THEME);

    api.activeTheme.value = OCEAN_PRESET;
    api.themeStorage.value = {
      version: 2,
      preset: null,
      label: 'Custom',
      overrides: regionThemeToSemanticOverrides(OCEAN_PRESET),
    };
    await nextTick();

    const snapshot = createSemanticTokenSnapshot(regionThemeToSemanticOverrides(OCEAN_PRESET));
    expect(document.documentElement.getAttribute('data-theme-custom')).toBe('true');
    expect(document.documentElement.getAttribute('data-region-theme')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--theme-surface-panel')).toBe(snapshot['surface-panel']);
    expect(document.documentElement.style.getPropertyValue('--theme-text-primary')).toBe(snapshot['text-primary']);

    unmount();
  });

  it('applyPreset("ocean") sets the correct theme config', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();
    vi.runAllTimers();

    expect(api.activeTheme.value).toEqual(OCEAN_PRESET);
    expect(document.documentElement.getAttribute('data-region-theme')).toBe('ocean');
    expect(window.localStorage.getItem(storageKey(StorageKeys.settings.themeTokens))).toContain('"version":2');
    expect(document.documentElement.style.getPropertyValue('--region-top-bg')).toBe('#1a1a2e');
    expect(document.documentElement.style.getPropertyValue('--region-side-bg')).toBe('#102542');
    expect(document.documentElement.style.getPropertyValue('--region-output-bg')).toBe('#13293d');

    unmount();
  });

  it('resetTheme clears theme attributes and overrides', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();
    api.resetTheme();
    await nextTick();

    expect(api.activeTheme.value).toBeNull();
    expect(api.themeStorage.value).toBeNull();
    expect(document.documentElement.getAttribute('data-region-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-theme-custom')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--region-top-bg')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--region-side-bg')).toBe('');

    unmount();
  });
});
