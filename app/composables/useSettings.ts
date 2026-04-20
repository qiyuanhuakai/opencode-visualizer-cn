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

function isSerializedEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

const DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB = 10;
const MIN_OPEN_IN_EDITOR_MAX_SIZE_MB = 1;
const MAX_OPEN_IN_EDITOR_MAX_SIZE_MB = 100;
const DEFAULT_TERMINAL_FONT_SIZE_PX = 13;
const MIN_TERMINAL_FONT_SIZE_PX = 8;
const MAX_TERMINAL_FONT_SIZE_PX = 24;
const DEFAULT_APP_FONT_SIZE_PX = 13;
const MIN_APP_FONT_SIZE_PX = 10;
const MAX_APP_FONT_SIZE_PX = 20;
const DEFAULT_MESSAGE_FONT_SIZE_PX = 13;
const MIN_MESSAGE_FONT_SIZE_PX = 10;
const MAX_MESSAGE_FONT_SIZE_PX = 20;
const DEFAULT_UI_FONT_SIZE_PX = 12;
const MIN_UI_FONT_SIZE_PX = 10;
const MAX_UI_FONT_SIZE_PX = 16;
const DEFAULT_TERMINAL_FONT_FAMILY =
  "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', 'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NFM', 'IosevkaTerm Nerd Font', 'Iosevka Term', 'Iosevka Fixed', 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace";
const DEFAULT_APP_MONOSPACE_FONT_FAMILY =
  "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace";

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

function normalizeTerminalFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE_PX;
  const rounded = Math.round(value);
  if (rounded < MIN_TERMINAL_FONT_SIZE_PX) return MIN_TERMINAL_FONT_SIZE_PX;
  if (rounded > MAX_TERMINAL_FONT_SIZE_PX) return MAX_TERMINAL_FONT_SIZE_PX;
  return rounded;
}

function normalizeAppFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_APP_FONT_SIZE_PX;
  const rounded = Math.round(value);
  if (rounded < MIN_APP_FONT_SIZE_PX) return MIN_APP_FONT_SIZE_PX;
  if (rounded > MAX_APP_FONT_SIZE_PX) return MAX_APP_FONT_SIZE_PX;
  return rounded;
}

function normalizeMessageFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MESSAGE_FONT_SIZE_PX;
  const rounded = Math.round(value);
  if (rounded < MIN_MESSAGE_FONT_SIZE_PX) return MIN_MESSAGE_FONT_SIZE_PX;
  if (rounded > MAX_MESSAGE_FONT_SIZE_PX) return MAX_MESSAGE_FONT_SIZE_PX;
  return rounded;
}

function normalizeUiFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_UI_FONT_SIZE_PX;
  const rounded = Math.round(value);
  if (rounded < MIN_UI_FONT_SIZE_PX) return MIN_UI_FONT_SIZE_PX;
  if (rounded > MAX_UI_FONT_SIZE_PX) return MAX_UI_FONT_SIZE_PX;
  return rounded;
}

function readTerminalFontSizePx() {
  const raw = storageGet(StorageKeys.settings.terminalFontSizePx);
  if (!raw) return DEFAULT_TERMINAL_FONT_SIZE_PX;
  const parsed = Number(raw);
  return normalizeTerminalFontSizePx(parsed);
}

function readAppFontSizePx() {
  const raw = storageGet(StorageKeys.settings.appFontSizePx);
  if (!raw) return DEFAULT_APP_FONT_SIZE_PX;
  const parsed = Number(raw);
  return normalizeAppFontSizePx(parsed);
}

function readMessageFontSizePx() {
  const raw = storageGet(StorageKeys.settings.messageFontSizePx);
  if (!raw) return DEFAULT_MESSAGE_FONT_SIZE_PX;
  const parsed = Number(raw);
  return normalizeMessageFontSizePx(parsed);
}

function readUiFontSizePx() {
  const raw = storageGet(StorageKeys.settings.uiFontSizePx);
  if (!raw) return DEFAULT_UI_FONT_SIZE_PX;
  const parsed = Number(raw);
  return normalizeUiFontSizePx(parsed);
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
const terminalFontFamily = ref(readTerminalFontFamily());
const appMonospaceFontFamily = ref(readAppMonospaceFontFamily());
const terminalFontSizePx = ref(readTerminalFontSizePx());
const appFontSizePx = ref(readAppFontSizePx());
const messageFontSizePx = ref(readMessageFontSizePx());
const uiFontSizePx = ref(readUiFontSizePx());
const showOpenInEditorButton = ref(storageGet(StorageKeys.settings.showOpenInEditorButton) !== 'false');
const openInEditorMaxSizeMb = ref(readOpenInEditorMaxSizeMb());
const floatingPreviewWordWrap = ref(storageGet(StorageKeys.settings.floatingPreviewWordWrap) === 'true');
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

watch(terminalFontSizePx, (value) => {
  storageSet(StorageKeys.settings.terminalFontSizePx, String(value));
}, syncWatchOptions);

watch(appFontSizePx, (value) => {
  storageSet(StorageKeys.settings.appFontSizePx, String(value));
}, syncWatchOptions);

watch(messageFontSizePx, (value) => {
  storageSet(StorageKeys.settings.messageFontSizePx, String(value));
}, syncWatchOptions);

watch(uiFontSizePx, (value) => {
  storageSet(StorageKeys.settings.uiFontSizePx, String(value));
}, syncWatchOptions);

watch(showOpenInEditorButton, (value) => {
  storageSet(StorageKeys.settings.showOpenInEditorButton, String(value));
}, syncWatchOptions);

watch(openInEditorMaxSizeMb, (value) => {
  storageSet(StorageKeys.settings.openInEditorMaxSizeMb, String(value));
}, syncWatchOptions);

watch(floatingPreviewWordWrap, (value) => {
  storageSet(StorageKeys.settings.floatingPreviewWordWrap, String(value));
}, syncWatchOptions);

watch(externalThemes, (value) => {
  if (value.length === 0) {
    if (storageGet(StorageKeys.settings.themeRegistry) === null) return;
    storageRemove(StorageKeys.settings.themeRegistry);
    return;
  }
  const payload = {
    version: 1,
    themes: value,
  };
  const current = storageGetJSON(StorageKeys.settings.themeRegistry);
  if (isSerializedEqual(current, payload)) return;
  storageSetJSON(StorageKeys.settings.themeRegistry, payload);
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
    if (event.key === storageKey(StorageKeys.settings.terminalFontFamily)) {
      terminalFontFamily.value = normalizeFontFamily(event.newValue ?? '', DEFAULT_TERMINAL_FONT_FAMILY);
    }
    if (event.key === storageKey(StorageKeys.settings.appMonospaceFontFamily)) {
      appMonospaceFontFamily.value = normalizeFontFamily(event.newValue ?? '', DEFAULT_APP_MONOSPACE_FONT_FAMILY);
    }
    if (event.key === storageKey(StorageKeys.settings.terminalFontSizePx)) {
      const parsed = event.newValue === null ? DEFAULT_TERMINAL_FONT_SIZE_PX : Number(event.newValue);
      terminalFontSizePx.value = normalizeTerminalFontSizePx(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.appFontSizePx)) {
      const parsed = event.newValue === null ? DEFAULT_APP_FONT_SIZE_PX : Number(event.newValue);
      appFontSizePx.value = normalizeAppFontSizePx(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.messageFontSizePx)) {
      const parsed = event.newValue === null ? DEFAULT_MESSAGE_FONT_SIZE_PX : Number(event.newValue);
      messageFontSizePx.value = normalizeMessageFontSizePx(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.uiFontSizePx)) {
      const parsed = event.newValue === null ? DEFAULT_UI_FONT_SIZE_PX : Number(event.newValue);
      uiFontSizePx.value = normalizeUiFontSizePx(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.showOpenInEditorButton)) {
      showOpenInEditorButton.value = event.newValue !== 'false';
    }
    if (event.key === storageKey(StorageKeys.settings.openInEditorMaxSizeMb)) {
      const parsed = event.newValue === null ? DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB : Number(event.newValue);
      openInEditorMaxSizeMb.value = normalizeOpenInEditorMaxSizeMb(parsed);
    }
    if (event.key === storageKey(StorageKeys.settings.floatingPreviewWordWrap)) {
      floatingPreviewWordWrap.value = event.newValue === 'true';
    }
    if (event.key === storageKey(StorageKeys.settings.themeTokens)) {
      const nextThemeStorage = normalizeThemeStorage(storageGetJSON(StorageKeys.settings.themeTokens));
      if (!isSerializedEqual(themeStorage.value, nextThemeStorage)) {
        themeStorage.value = nextThemeStorage;
      }
    }
    if (event.key === storageKey(StorageKeys.settings.themeRegistry)) {
      const nextExternalThemes = normalizeStoredExternalThemes(storageGetJSON(StorageKeys.settings.themeRegistry));
      if (!isSerializedEqual(externalThemes.value, nextExternalThemes)) {
        externalThemes.value = nextExternalThemes;
      }
    }
  });
}

export function useSettings() {
  return {
    enterToSend,
    suppressAutoWindows,
    showMinimizeButtons,
    dockAlwaysOpen,
    terminalFontFamily,
    appMonospaceFontFamily,
    themeStorage,
    externalThemes,
    showOpenInEditorButton,
    openInEditorMaxSizeMb,
    floatingPreviewWordWrap,
    defaultOpenInEditorMaxSizeMb: DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB,
    minOpenInEditorMaxSizeMb: MIN_OPEN_IN_EDITOR_MAX_SIZE_MB,
    maxOpenInEditorMaxSizeMb: MAX_OPEN_IN_EDITOR_MAX_SIZE_MB,
    defaultTerminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaultAppMonospaceFontFamily: DEFAULT_APP_MONOSPACE_FONT_FAMILY,
    terminalFontSizePx,
    appFontSizePx,
    messageFontSizePx,
    uiFontSizePx,
    defaultTerminalFontSizePx: DEFAULT_TERMINAL_FONT_SIZE_PX,
    minTerminalFontSizePx: MIN_TERMINAL_FONT_SIZE_PX,
    maxTerminalFontSizePx: MAX_TERMINAL_FONT_SIZE_PX,
    defaultAppFontSizePx: DEFAULT_APP_FONT_SIZE_PX,
    minAppFontSizePx: MIN_APP_FONT_SIZE_PX,
    maxAppFontSizePx: MAX_APP_FONT_SIZE_PX,
    defaultMessageFontSizePx: DEFAULT_MESSAGE_FONT_SIZE_PX,
    minMessageFontSizePx: MIN_MESSAGE_FONT_SIZE_PX,
    maxMessageFontSizePx: MAX_MESSAGE_FONT_SIZE_PX,
    defaultUiFontSizePx: DEFAULT_UI_FONT_SIZE_PX,
    minUiFontSizePx: MIN_UI_FONT_SIZE_PX,
    maxUiFontSizePx: MAX_UI_FONT_SIZE_PX,
  };
}
