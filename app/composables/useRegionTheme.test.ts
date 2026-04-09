import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick } from 'vue';

import { OCEAN_PRESET, generateCSS } from '../utils/regionTheme';
import { StorageKeys, storageKey } from '../utils/storageKeys';

describe('useRegionTheme', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    document.getElementById('region-theme-overrides')?.remove();
  });

  afterEach(() => {
    document.getElementById('region-theme-overrides')?.remove();
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

  it('creates and updates the style tag when activeTheme changes', async () => {
    const { api, unmount } = await mountComposable();

    const initialTag = document.getElementById('region-theme-overrides');
    expect(initialTag).toBeInstanceOf(HTMLStyleElement);
    expect(initialTag?.textContent).toBe('');

    api.activeTheme.value = OCEAN_PRESET;
    await nextTick();

    const updatedTag = document.getElementById('region-theme-overrides');
    expect(updatedTag?.textContent).toBe(generateCSS(OCEAN_PRESET));

    unmount();
  });

  it('applyPreset("ocean") sets the correct theme config', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();

    expect(api.activeTheme.value).toEqual(OCEAN_PRESET);
    expect(window.localStorage.getItem(storageKey(StorageKeys.settings.regionTheme))).toBe(JSON.stringify(OCEAN_PRESET));

    unmount();
  });

  it('resetTheme clears the style tag content', async () => {
    const { api, unmount } = await mountComposable();

    api.applyPreset('ocean');
    await nextTick();
    api.resetTheme();
    await nextTick();

    expect(api.activeTheme.value).toBeNull();
    expect(document.getElementById('region-theme-overrides')?.textContent).toBe('');

    unmount();
  });
});
