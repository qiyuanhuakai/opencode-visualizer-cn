import { ref, watch } from 'vue';
import { StorageKeys, storageGet, storageKey, storageSet, storageGetJSON, storageRemove, storageSetJSON } from '../utils/storageKeys';
import {
  migrateLegacyRegionThemeStorage,
  normalizeThemeStorage,
  type ThemeStorageV2,
} from '../utils/themeTokens';
import {
  normalizeStoredExternalThemes,
  type ExternalThemeDefinition,
} from '../utils/themeRegistry';

const DEFAULT_PINNED_SESSIONS_LIMIT = 30;
const MIN_PINNED_SESSIONS_LIMIT = 1;
const MAX_PINNED_SESSIONS_LIMIT = 200;
const DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB = 10;
const MIN_OPEN_IN_EDITOR_MAX_SIZE_MB = 1;
const MAX_OPEN_IN_EDITOR_MAX_SIZE_MB = 100;
const DEFAULT_TERMINAL_FONT_FAMILY =
  "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', 'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NFM', 'IosevkaTerm Nerd Font', 'Iosevka Term', 'Iosevka Fixed', 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace";
const DEFAULT_APP_MONOSPACE_FONT_FAMILY =
  "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace";

function normalizePinnedSessionsLimit(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_PINNED_SESSIONS_LIMIT;
  const rounded = Math.round(value);
  if (rounded < MIN_PINNED_SESSIONS_LIMIT) return MIN_PINNED_SESSIONS_LIMIT;
  if (rounded > MAX_PINNED_SESSIONS_LIMIT) return MAX_PINNED_SESSIONS_LIMIT;
  return rounded;
}

function normalizeOpenInEditorMaxSizeMb(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB;
  const rounded = Math.round(value);
  if (rounded < MIN_OPEN_IN_EDITOR_MAX_SIZE_MB) return MIN_OPEN_IN_EDITOR_MAX_SIZE_MB;
  if (rounded > MAX_OPEN_IN_EDITOR_MAX_SIZE_MB) return MAX_OPEN_IN_EDITOR_MAX_SIZE_MB;
  return rounded;
}

function readOpenInEditorMaxSizeMb() {
  const raw = storageGet(StorageKeys.settings.openInEditorMaxSizeMb);
  if (!raw) return DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB;
  const parsed = Number(raw);
  return normalizeOpenInEditorMaxSizeMb(parsed);
}

function readPinnedSessionsLimit() {
  const raw = storageGet(StorageKeys.settings.pinnedSessionsLimit);
  if (!raw) return DEFAULT_PINNED_SESSIONS_LIMIT;
  const parsed = Number(raw);
  return normalizePinnedSessionsLimit(parsed);
}

function readTerminalFontFamily() {
  return storageGet(StorageKeys.settings.terminalFontFamily) || DEFAULT_TERMINAL_FONT_FAMILY;
}

function readAppMonospaceFontFamily() {
  return storageGet(StorageKeys.settings.appMonospaceFontFamily) || DEFAULT_APP_MONOSPACE_FONT_FAMILY;
}

function normalizeFontFamily(value: string, fallback: string) {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : fallback;
}

function readThemeStorage(): ThemeStorageV2 | null {
  const current = normalizeThemeStorage(storageGetJSON(StorageKeys.settings.themeTokens));
  if (current) {
    storageSetJSON(StorageKeys.settings.themeTokens, current);
    }
  if (current) {
    return current;
  }

  const legacy = migrateLegacyRegionThemeStorage(storageGetJSON(StorageKeys.settings.regionTheme));
  if (legacy) {
    storageSetJSON(StorageKeys.settings.themeTokens, legacy);
    storageRemove(StorageKeys.settings.regionTheme);
    return legacy;
  }

  return null;
}

function readExternalThemes(): ExternalThemeDefinition[] {
  const current = normalizeStoredExternalThemes(storageGetJSON(StorageKeys.settings.themeRegistry));
  if (current.length > 0) {
    storageSetJSON(StorageKeys.settings.themeRegistry, {
      version: 1,
      themes: current,
    });
  }
  return current;
}

const enterToSend = ref(storageGet(StorageKeys.settings.enterToSend) === 'true');
const suppressAutoWindows = ref(storageGet(StorageKeys.settings.suppressAutoWindows) === 'true');
const showMinimizeButtons = ref(storageGet(StorageKeys.settings.showMinimizeButtons) !== 'false');
const dockAlwaysOpen = ref(storageGet(StorageKeys.settings.dockAlwaysOpen) === 'true');
const pinnedSessionsLimit = ref(readPinnedSessionsLimit());
const terminalFontFamily = ref(readTerminalFontFamily());
const appMonospaceFontFamily = ref(readAppMonospaceFontFamily());
const showOpenInEditorButton = ref(storageGet(StorageKeys.settings.showOpenInEditorButton) !== 'false');
const openInEditorMaxSizeMb = ref(readOpenInEditorMaxSizeMb());
const themeStorage = ref<ThemeStorageV2 | null>(readThemeStorage());
const externalThemes = ref<ExternalThemeDefinition[]>(readExternalThemes());

const syncWatchOptions = { flush: 'sync' as const };

watch(enterToSend, (value) => {
  storageSet(StorageKeys.settings.enterToSend, String(value));
}, syncWatchOptions);

watch(suppressAutoWindows, (value) => {
  storageSet(StorageKeys.settings.suppressAutoWindows, String(value));
}, syncWatchOptions);

watch(showMinimizeButtons, (value) => {
  storageSet(StorageKeys.settings.showMinimizeButtons, String(value));
}, syncWatchOptions);

watch(dockAlwaysOpen, (value) => {
  storageSet(StorageKeys.settings.dockAlwaysOpen, String(value));
}, syncWatchOptions);

watch(showMinimizeButtons, (value) => {
  if (value) return;
  dockAlwaysOpen.value = false;
}, syncWatchOptions);

watch(pinnedSessionsLimit, (value) => {
  const normalized = normalizePinnedSessionsLimit(value);
  if (normalized !== value) {
    pinnedSessionsLimit.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.pinnedSessionsLimit, String(normalized));
}, syncWatchOptions);

watch(terminalFontFamily, (value) => {
  const normalized = normalizeFontFamily(value, DEFAULT_TERMINAL_FONT_FAMILY);
  if (normalized !== value) {
    terminalFontFamily.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.terminalFontFamily, normalized);
}, syncWatchOptions);

watch(appMonospaceFontFamily, (value) => {
  const normalized = normalizeFontFamily(value, DEFAULT_APP_MONOSPACE_FONT_FAMILY);
  if (normalized !== value) {
    appMonospaceFontFamily.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.appMonospaceFontFamily, normalized);
}, syncWatchOptions);

watch(showOpenInEditorButton, (value) => {
  storageSet(StorageKeys.settings.showOpenInEditorButton, String(value));
}, syncWatchOptions);

watch(openInEditorMaxSizeMb, (value) => {
  const normalized = normalizeOpenInEditorMaxSizeMb(value);
  if (normalized !== value) {
    openInEditorMaxSizeMb.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.openInEditorMaxSizeMb, String(normalized));
}, syncWatchOptions);

watch(externalThemes, (value) => {
  if (value.length === 0) {
    storageRemove(StorageKeys.settings.themeRegistry);
    return;
  }
  storageSetJSON(StorageKeys.settings.themeRegistry, {
    version: 1,
    themes: value,
  });
}, { deep: true, flush: 'sync' });

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey(StorageKeys.settings.enterToSend)) {
      enterToSend.value = event.newValue === 'true';
    }
    if (event.key === storageKey(StorageKeys.settings.suppressAutoWindows)) {
      suppressAutoWindows.value = event.newValue === 'true';
    }
    if (event.key === storageKey(StorageKeys.settings.showMinimizeButtons)) {
      showMinimizeButtons.value = event.newValue !== 'false';
    }
    if (event.key === storageKey(StorageKeys.settings.dockAlwaysOpen)) {
      dockAlwaysOpen.value = event.newValue === 'true';
    }
    if (event.key === storageKey(StorageKeys.settings.pinnedSessionsLimit)) {
      const parsed = event.newValue === null ? DEFAULT_PINNED_SESSIONS_LIMIT : Number(event.newValue);
      pinnedSessionsLimit.value = normalizePinnedSessionsLimit(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.terminalFontFamily)) {
      terminalFontFamily.value = normalizeFontFamily(event.newValue ?? '', DEFAULT_TERMINAL_FONT_FAMILY);
    }
    if (event.key === storageKey(StorageKeys.settings.appMonospaceFontFamily)) {
      appMonospaceFontFamily.value = normalizeFontFamily(event.newValue ?? '', DEFAULT_APP_MONOSPACE_FONT_FAMILY);
    }
    if (event.key === storageKey(StorageKeys.settings.showOpenInEditorButton)) {
      showOpenInEditorButton.value = event.newValue !== 'false';
    }
    if (event.key === storageKey(StorageKeys.settings.openInEditorMaxSizeMb)) {
      const parsed = event.newValue === null ? DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB : Number(event.newValue);
      openInEditorMaxSizeMb.value = normalizeOpenInEditorMaxSizeMb(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.themeTokens)) {
      const nextThemeStorage = normalizeThemeStorage(storageGetJSON(StorageKeys.settings.themeTokens));
      themeStorage.value = nextThemeStorage;
    }
    if (event.key === storageKey(StorageKeys.settings.themeRegistry)) {
      externalThemes.value = normalizeStoredExternalThemes(storageGetJSON(StorageKeys.settings.themeRegistry));
    }
  });
}

export function useSettings() {
  return {
    enterToSend,
    suppressAutoWindows,
    showMinimizeButtons,
    dockAlwaysOpen,
    pinnedSessionsLimit,
    terminalFontFamily,
    appMonospaceFontFamily,
    themeStorage,
    externalThemes,
    showOpenInEditorButton,
    openInEditorMaxSizeMb,
    defaultPinnedSessionsLimit: DEFAULT_PINNED_SESSIONS_LIMIT,
    minPinnedSessionsLimit: MIN_PINNED_SESSIONS_LIMIT,
    maxPinnedSessionsLimit: MAX_PINNED_SESSIONS_LIMIT,
    defaultOpenInEditorMaxSizeMb: DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB,
    minOpenInEditorMaxSizeMb: MIN_OPEN_IN_EDITOR_MAX_SIZE_MB,
    maxOpenInEditorMaxSizeMb: MAX_OPEN_IN_EDITOR_MAX_SIZE_MB,
    defaultTerminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaultAppMonospaceFontFamily: DEFAULT_APP_MONOSPACE_FONT_FAMILY,
  };
}
