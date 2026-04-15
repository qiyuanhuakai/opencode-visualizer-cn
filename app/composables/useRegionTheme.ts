import { onUnmounted, watch } from 'vue';

import { useSettings } from './useSettings';
import {
  DEFAULT_REGION_THEME,
} from '../utils/regionTheme';
import { StorageKeys, storageSetJSON } from '../utils/storageKeys';
import {
  DEFAULT_SYNTAX_THEME,
  SEMANTIC_THEME_TOKENS,
  THEME_ROOT_ATTRIBUTE,
  createSemanticTokenSnapshot,
  extractSemanticTokenOverrides,
  regionThemeToStorage,
  resolveThemeStoragePreset,
  semanticTokenCssVariable,
  type ThemeStorageV2,
} from '../utils/themeTokens';
import { resolveThemeRegistryTheme } from '../utils/themeRegistry';

const REGION_THEME_PERSIST_DEBOUNCE_MS = 140;

let sharedConsumerCount = 0;
let sharedStopWatching: (() => void) | null = null;
let persistTimer: number | null = null;
let pendingPersistValue: ThemeStorageV2 | null | undefined;

function clearPersistTimer() {
  if (persistTimer == null || typeof window === 'undefined') return;
  window.clearTimeout(persistTimer);
  persistTimer = null;
}

function flushPendingPersist() {
  if (pendingPersistValue === undefined) return;
  if (pendingPersistValue === null) {
    storageSetJSON(StorageKeys.settings.themeTokens, null);
  } else {
    storageSetJSON(StorageKeys.settings.themeTokens, pendingPersistValue);
  }
  pendingPersistValue = undefined;
}

function schedulePersist(value: ThemeStorageV2 | null) {
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
  const { themeStorage, externalThemes } = useSettings();

  function syncThemeVariables(root: HTMLElement) {
    for (const token of SEMANTIC_THEME_TOKENS) {
      root.style.removeProperty(semanticTokenCssVariable(token));
    }

    const semanticSnapshot = createSemanticTokenSnapshot(extractSemanticTokenOverrides(themeStorage.value));
    for (const token of SEMANTIC_THEME_TOKENS) {
      const value = semanticSnapshot[token];
      if (value) {
        root.style.setProperty(semanticTokenCssVariable(token), value);
      }
    }
  }

  function updateStyleTag() {
    const root = typeof document === 'undefined' ? null : document.documentElement;
    if (!root) {
      return;
    }

    const presetName = resolveThemeStoragePreset(themeStorage.value);
    if (presetName && presetName !== DEFAULT_REGION_THEME.name) {
      root.setAttribute(THEME_ROOT_ATTRIBUTE, presetName);
    } else {
      root.removeAttribute(THEME_ROOT_ATTRIBUTE);
    }

    syncThemeVariables(root);

    root.style.setProperty('--syntax-theme-name', DEFAULT_SYNTAX_THEME);
  }

  function applyPreset(name: string) {
    const presetTheme = name === DEFAULT_REGION_THEME.name ? null : resolveThemeRegistryTheme(name, externalThemes.value);
    themeStorage.value = presetTheme ? regionThemeToStorage(presetTheme) : null;
  }

  function resetTheme() {
    themeStorage.value = null;
  }

  if (!sharedStopWatching) {
    let isInitialSync = true;
    sharedStopWatching = watch(
      themeStorage,
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
        document.documentElement.removeAttribute(THEME_ROOT_ATTRIBUTE);
        document.documentElement.style.removeProperty('--syntax-theme-name');
        for (const token of SEMANTIC_THEME_TOKENS) {
          document.documentElement.style.removeProperty(semanticTokenCssVariable(token));
        }
      }
    }
  });

  return {
    themeStorage,
    applyPreset,
    resetTheme,
  };
}
