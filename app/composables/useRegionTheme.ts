import { onUnmounted, watch } from 'vue';

import { useSettings } from './useSettings';
import {
  DEFAULT_REGION_THEME,
  generateCSS,
  resolveRegionThemePreset,
  type RegionThemeConfig,
} from '../utils/regionTheme';
import { StorageKeys, storageSetJSON } from '../utils/storageKeys';

const STYLE_TAG_ID = 'region-theme-overrides';
const REGION_THEME_PERSIST_DEBOUNCE_MS = 140;

let sharedConsumerCount = 0;
let sharedStopWatching: (() => void) | null = null;
let persistTimer: number | null = null;
let pendingPersistValue: RegionThemeConfig | null | undefined;

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

function clearPersistTimer() {
  if (persistTimer == null || typeof window === 'undefined') return;
  window.clearTimeout(persistTimer);
  persistTimer = null;
}

function flushPendingPersist() {
  if (pendingPersistValue === undefined) return;
  storageSetJSON(StorageKeys.settings.regionTheme, pendingPersistValue);
  pendingPersistValue = undefined;
}

function schedulePersist(value: RegionThemeConfig | null) {
  pendingPersistValue = value;
  if (typeof window === 'undefined') {
    flushPendingPersist();
    return;
  }
  clearPersistTimer();
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    flushPendingPersist();
  }, REGION_THEME_PERSIST_DEBOUNCE_MS);
}

export function useRegionTheme() {
  const { regionTheme: activeTheme } = useSettings();

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
    activeTheme.value = name === DEFAULT_REGION_THEME.name ? null : resolveRegionThemePreset(name);
  }

  function resetTheme() {
    activeTheme.value = null;
  }

  if (!sharedStopWatching) {
    let isInitialSync = true;
    sharedStopWatching = watch(
      activeTheme,
      (value) => {
        updateStyleTag();
        if (isInitialSync) {
          isInitialSync = false;
          return;
        }
        schedulePersist(value);
      },
      { immediate: true },
    );
  }

  sharedConsumerCount += 1;

  onUnmounted(() => {
    sharedConsumerCount = Math.max(0, sharedConsumerCount - 1);
    if (sharedConsumerCount === 0) {
      clearPersistTimer();
      flushPendingPersist();
      sharedStopWatching?.();
      sharedStopWatching = null;

      if (typeof document !== 'undefined') {
        document.getElementById(STYLE_TAG_ID)?.remove();
      }
    }
  });

  return {
    activeTheme,
    applyPreset,
    resetTheme,
    generateStyleTagContent,
  };
}
