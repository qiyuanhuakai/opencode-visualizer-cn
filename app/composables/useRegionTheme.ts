import { onUnmounted, watch } from 'vue';

import { useSettings } from './useSettings';
import {
  DEFAULT_REGION_THEME,
  REGION_COLOR_FIELDS,
  REGION_VAR_PREFIXES,
  REGION_NAMES,
  resolveRegionThemePreset,
  type RegionColors,
} from '../utils/regionTheme';
import { StorageKeys, storageSetJSON } from '../utils/storageKeys';
import {
  DEFAULT_SYNTAX_THEME,
  SEMANTIC_THEME_TOKENS,
  THEME_ROOT_ATTRIBUTE,
  buildRegionCompatibilityCss,
  createThemeStorageFromEditor,
  createSemanticTokenSnapshot,
  extractSemanticTokenOverrides,
  extractRegionVariableOverrides,
  isCustomThemeStorage,
  regionThemeToSemanticOverrides,
  resolveThemeStoragePreset,
  semanticTokenCssVariable,
  type ThemeStorageV2,
} from '../utils/themeTokens';

const THEME_COMPAT_STYLE_TAG_ID = 'region-theme-compat';
const REGION_THEME_PERSIST_DEBOUNCE_MS = 140;

let sharedConsumerCount = 0;
let sharedStopWatching: (() => void) | null = null;
let persistTimer: number | null = null;
let pendingPersistValue: ThemeStorageV2 | null | undefined;

function ensureCompatibilityStyleTag() {
  if (typeof document === 'undefined') {
    return null;
  }

  const existing = document.getElementById(THEME_COMPAT_STYLE_TAG_ID);
  if (existing instanceof HTMLStyleElement) {
    return existing;
  }

  const styleTag = document.createElement('style');
  styleTag.id = THEME_COMPAT_STYLE_TAG_ID;
  styleTag.textContent = buildRegionCompatibilityCss();
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
  const { themeStorage, regionTheme: activeTheme } = useSettings();

  function syncRegionVariables(root: HTMLElement) {
    const regionOverrides = extractRegionVariableOverrides(activeTheme.value);

    function fieldToCssSegment(field: keyof RegionColors): string {
      switch (field) {
        case 'controlBg':
          return 'control-bg';
        case 'activeBg':
          return 'active-bg';
        case 'activeText':
          return 'active-text';
        case 'textMuted':
          return 'text-muted';
        default:
          return field;
      }
    }

    for (const token of SEMANTIC_THEME_TOKENS) {
      root.style.removeProperty(semanticTokenCssVariable(token));
    }

    for (const regionName of REGION_NAMES) {
      const prefix = REGION_VAR_PREFIXES[regionName];
      for (const field of REGION_COLOR_FIELDS) {
        root.style.removeProperty(`--region-${prefix}-${fieldToCssSegment(field)}`);
      }
    }

    Object.entries(regionOverrides).forEach(([cssVar, value]) => {
      root.style.setProperty(cssVar, value);
    });

    const semanticSnapshot = createSemanticTokenSnapshot(extractSemanticTokenOverrides(themeStorage.value));
    for (const token of SEMANTIC_THEME_TOKENS) {
      root.style.setProperty(semanticTokenCssVariable(token), semanticSnapshot[token]);
    }
  }

  function updateStyleTag() {
    ensureCompatibilityStyleTag();
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

    syncRegionVariables(root);

    if (isCustomThemeStorage(themeStorage.value)) {
      root.setAttribute('data-theme-custom', 'true');
    } else {
      root.removeAttribute('data-theme-custom');
    }

    root.style.setProperty('--syntax-theme-name', DEFAULT_SYNTAX_THEME);
  }

  function applyPreset(name: string) {
    const presetTheme = name === DEFAULT_REGION_THEME.name ? null : resolveRegionThemePreset(name);
    activeTheme.value = presetTheme;
    themeStorage.value = presetTheme ? createThemeStorageFromEditor(regionThemeToSemanticOverrides(presetTheme), presetTheme.name, presetTheme.label) : null;
    if (themeStorage.value && presetTheme) {
      themeStorage.value = {
        ...themeStorage.value,
        regions: Object.fromEntries(
          Object.entries(presetTheme.regions).map(([regionName, colors]) => [regionName, { ...colors }]),
        ) as ThemeStorageV2['regions'],
      };
    }
  }

  function resetTheme() {
    activeTheme.value = null;
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
        document.getElementById(THEME_COMPAT_STYLE_TAG_ID)?.remove();
        document.documentElement.removeAttribute(THEME_ROOT_ATTRIBUTE);
        document.documentElement.removeAttribute('data-theme-custom');
        document.documentElement.style.removeProperty('--syntax-theme-name');
        for (const token of SEMANTIC_THEME_TOKENS) {
          document.documentElement.style.removeProperty(semanticTokenCssVariable(token));
        }
      }
    }
  });

  return {
    activeTheme,
    themeStorage,
    applyPreset,
    resetTheme,
  };
}
