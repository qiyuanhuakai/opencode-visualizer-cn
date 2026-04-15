import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';

import { OCEAN_PRESET } from '../utils/regionTheme';
import { StorageKeys, storageKey } from '../utils/storageKeys';
import {
  DEFAULT_SYNTAX_THEME,
  SEMANTIC_THEME_TOKENS,
  createSemanticTokenSnapshot,
  regionThemeToStorage,
  semanticTokenCssVariable,
} from '../utils/themeTokens';

describe('useRegionTheme', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-region-theme');
    document.documentElement.style.removeProperty('--syntax-theme-name');
    for (const token of SEMANTIC_THEME_TOKENS) {
      document.documentElement.style.removeProperty(semanticTokenCssVariable(token));
    }
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    document.documentElement.removeAttribute('data-region-theme');
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

  it('syncs semantic tokens from theme storage', async () => {
    const { api, unmount } = await mountComposable();

    expect(document.documentElement.style.getPropertyValue('--syntax-theme-name')).toBe(DEFAULT_SYNTAX_THEME);

    api.themeStorage.value = regionThemeToStorage(OCEAN_PRESET);
    await nextTick();

    const snapshot = createSemanticTokenSnapshot(api.themeStorage.value?.overrides);
    expect(document.documentElement.getAttribute('data-region-theme')).toBe('ocean');
    expect(document.documentElement.style.getPropertyValue('--theme-surface-panel')).toBe(snapshot['surface-panel']);
    expect(document.documentElement.style.getPropertyValue('--theme-text-primary')).toBe(snapshot['text-primary']);
    expect(document.documentElement.style.getPropertyValue('--theme-top-bg')).toBe('#1a1a2e');
    expect(document.documentElement.style.getPropertyValue('--theme-side-bg')).toBe('#102542');
    expect(document.documentElement.style.getPropertyValue('--theme-login-bg')).toBe('#0f2033');

    unmount();
  });

  it('applyPreset("ocean") sets the correct theme config', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();
    vi.runAllTimers();

    expect(document.documentElement.getAttribute('data-region-theme')).toBe('ocean');
    expect(window.localStorage.getItem(storageKey(StorageKeys.settings.themeTokens))).toContain('"version":2');
    expect(document.documentElement.style.getPropertyValue('--theme-top-bg')).toBe('#1a1a2e');
    expect(document.documentElement.style.getPropertyValue('--theme-side-bg')).toBe('#102542');
    expect(document.documentElement.style.getPropertyValue('--theme-output-bg')).toBe('#13293d');
    expect(document.documentElement.style.getPropertyValue('--theme-login-bg')).toBe('#0f2033');

    unmount();
  });

  it('resetTheme clears theme attributes and overrides', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();
    api.resetTheme();
    await nextTick();

    expect(api.themeStorage.value).toBeNull();
    expect(document.documentElement.getAttribute('data-region-theme')).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--theme-top-bg')).toBe('rgba(15, 23, 42, 0.92)');
    expect(document.documentElement.style.getPropertyValue('--theme-side-bg')).toBe('rgba(15, 23, 42, 0.92)');
    expect(document.documentElement.style.getPropertyValue('--theme-login-bg')).toBe('rgba(15, 23, 42, 0.98)');

    unmount();
  });
});
