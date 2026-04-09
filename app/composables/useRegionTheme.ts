import { onUnmounted, ref, watch, type Ref } from 'vue';

import { useSettings } from './useSettings';
import {
  DEFAULT_REGION_THEME,
  FOREST_PRESET,
  OCEAN_PRESET,
  SAKURA_PRESET,
  generateCSS,
  type RegionThemeConfig,
} from '../utils/regionTheme';
import { StorageKeys, storageGetJSON, storageSetJSON } from '../utils/storageKeys';

const STYLE_TAG_ID = 'region-theme-overrides';

function resolveActiveThemeRef(): Ref<RegionThemeConfig | null> {
  const settings = useSettings();

  if ('regionTheme' in settings && settings.regionTheme) {
    return settings.regionTheme;
  }

  return ref<RegionThemeConfig | null>(storageGetJSON(StorageKeys.settings.regionTheme) ?? null);
}

function ensureStyleTag() {
  if (typeof document === 'undefined') {
    return null;
  }

  const existing = document.getElementById(STYLE_TAG_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const styleTag = document.createElement('style');
  styleTag.id = STYLE_TAG_ID;
  document.head.appendChild(styleTag);
  return styleTag;
}

export function useRegionTheme() {
  const activeTheme = resolveActiveThemeRef();

  function generateStyleTagContent() {
    return generateCSS(activeTheme.value);
  }

  function updateStyleTag() {
    const styleTag = ensureStyleTag();
    if (!styleTag) {
      return;
    }

    styleTag.textContent = generateStyleTagContent();
  }

  function applyPreset(name: string) {
    if (name === DEFAULT_REGION_THEME.name) {
      activeTheme.value = null;
      return;
    }

    if (name === OCEAN_PRESET.name) {
      activeTheme.value = OCEAN_PRESET;
      return;
    }

    if (name === FOREST_PRESET.name) {
      activeTheme.value = FOREST_PRESET;
      return;
    }

    if (name === SAKURA_PRESET.name) {
      activeTheme.value = SAKURA_PRESET;
      return;
    }
  }

  function resetTheme() {
    activeTheme.value = null;
  }

  const stopWatching = watch(
    activeTheme,
    (value) => {
      storageSetJSON(StorageKeys.settings.regionTheme, value);
      updateStyleTag();
    },
    { immediate: true },
  );

  onUnmounted(() => {
    stopWatching();

    if (typeof document !== 'undefined') {
      document.getElementById(STYLE_TAG_ID)?.remove();
    }
  });

  return {
    activeTheme,
    applyPreset,
    resetTheme,
    generateStyleTagContent,
  };
}
