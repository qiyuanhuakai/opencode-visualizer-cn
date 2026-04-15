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
    expect(document.documentElement.style.getPropertyValue('--theme-dropdown-bg')).toBe(snapshot['dropdown-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-chip-bg-neutral')).toBe(snapshot['chip-bg-neutral']);
    expect(document.documentElement.style.getPropertyValue('--theme-icon-action-bg')).toBe(snapshot['icon-action-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-dock-tray-bg')).toBe(snapshot['dock-tray-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-form-control-bg')).toBe(snapshot['form-control-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-tab-bg')).toBe(snapshot['tab-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-badge-bg')).toBe(snapshot['badge-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-card-bg')).toBe(snapshot['card-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-toggle-track')).toBe(snapshot['toggle-track']);
    expect(document.documentElement.style.getPropertyValue('--theme-list-row-bg')).toBe(snapshot['list-row-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-empty-state-text')).toBe(snapshot['empty-state-text']);
    expect(document.documentElement.style.getPropertyValue('--theme-action-button-bg')).toBe(snapshot['action-button-bg']);
    expect(document.documentElement.style.getPropertyValue('--theme-search-bg')).toBe(snapshot['search-bg']);

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
    expect(document.documentElement.style.getPropertyValue('--theme-dropdown-bg')).toBe('rgba(2, 6, 23, 0.98)');
    expect(document.documentElement.style.getPropertyValue('--theme-form-button-primary-bg')).toBe('#1e40af');
    expect(document.documentElement.style.getPropertyValue('--theme-tab-bg')).toBe('rgba(11, 19, 32, 0.92)');
    expect(document.documentElement.style.getPropertyValue('--theme-badge-bg')).toBe('rgba(15, 23, 42, 0.75)');
    expect(document.documentElement.style.getPropertyValue('--theme-card-bg')).toBe('rgba(11, 19, 32, 0.92)');

    unmount();
  });
});
