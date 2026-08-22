import { ref, watch, type Ref } from 'vue';
import {
  StorageKeys,
  storageGet,
  storageKey,
  storageSet,
  storageGetJSON,
  storageRemove,
  storageSetJSON,
} from '../utils/storageKeys';
import {
  migrateLegacyRegionThemeStorage,
  normalizeThemeStorage,
  type ThemeStorageV2,
} from '../utils/themeTokens';
import {
  normalizeStoredExternalThemes,
  type ExternalThemeDefinition,
} from '../utils/themeRegistry';
import {
  DEFAULT_EDITOR_SHORTCUTS,
  normalizeEditorShortcutMap,
  type EditorShortcutMap,
} from '../utils/editorShortcuts';
import { normalizeTextTransformers, type TextTransformer } from '../utils/textTransformers';

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
const DEFAULT_SIDEBAR_FONT_SIZE_PX = 12;
const MIN_SIDEBAR_FONT_SIZE_PX = 10;
const MAX_SIDEBAR_FONT_SIZE_PX = 20;
const DEFAULT_UI_FONT_SIZE_PX = 12;
const MIN_UI_FONT_SIZE_PX = 10;
const MAX_UI_FONT_SIZE_PX = 16;
const MIN_EDITOR_FONT_SIZE_PX = 10;
const MAX_EDITOR_FONT_SIZE_PX = 28;
const DEFAULT_EDITOR_TAB_SIZE = 2;
const MIN_EDITOR_TAB_SIZE = 1;
const MAX_EDITOR_TAB_SIZE = 8;
const DEFAULT_TERMINAL_FONT_FAMILY =
  "'FiraCode Nerd Font Mono', 'FiraCode Nerd Font Mono Med', 'CaskaydiaCove Nerd Font Mono', 'CaskaydiaCove NFM', 'IosevkaTerm Nerd Font', 'Iosevka Term', 'Iosevka Fixed', 'JetBrains Mono', 'Cascadia Mono', 'SFMono-Regular', 'Menlo', 'Consolas', 'Liberation Mono', monospace";
const DEFAULT_APP_MONOSPACE_FONT_FAMILY =
  "'SF Mono', 'JetBrains Mono', 'Fira Code', ui-monospace, 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace";

function normalizeOpenInEditorMaxSizeMb(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB;
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
  return (
    storageGet(StorageKeys.settings.appMonospaceFontFamily) || DEFAULT_APP_MONOSPACE_FONT_FAMILY
  );
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

function normalizeSidebarFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SIDEBAR_FONT_SIZE_PX;
  const rounded = Math.round(value);
  if (rounded < MIN_SIDEBAR_FONT_SIZE_PX) return MIN_SIDEBAR_FONT_SIZE_PX;
  if (rounded > MAX_SIDEBAR_FONT_SIZE_PX) return MAX_SIDEBAR_FONT_SIZE_PX;
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

function readSidebarFontSizePx() {
  const raw = storageGet(StorageKeys.settings.sidebarFontSizePx);
  if (!raw) return DEFAULT_SIDEBAR_FONT_SIZE_PX;
  return normalizeSidebarFontSizePx(Number(raw));
}

function readUiFontSizePx() {
  const raw = storageGet(StorageKeys.settings.uiFontSizePx);
  if (!raw) return DEFAULT_UI_FONT_SIZE_PX;
  const parsed = Number(raw);
  return normalizeUiFontSizePx(parsed);
}

function normalizeEditorFontSizePx(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(MIN_EDITOR_FONT_SIZE_PX, Math.min(MAX_EDITOR_FONT_SIZE_PX, Math.round(value)));
}

function normalizeEditorTabSize(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EDITOR_TAB_SIZE;
  return Math.max(MIN_EDITOR_TAB_SIZE, Math.min(MAX_EDITOR_TAB_SIZE, Math.round(value)));
}

function readEditorFontSizePx() {
  const raw = storageGet(StorageKeys.settings.editorFontSizePx);
  return raw === null ? null : normalizeEditorFontSizePx(Number(raw));
}

function readEditorTabSize() {
  const raw = storageGet(StorageKeys.settings.editorTabSize);
  return raw === null ? DEFAULT_EDITOR_TAB_SIZE : normalizeEditorTabSize(Number(raw));
}

function readEditorShortcuts() {
  return normalizeEditorShortcutMap(storageGetJSON(StorageKeys.settings.editorShortcuts));
}

function parseTextTransformers(value: string | null): TextTransformer[] {
  if (!value) return [];
  try {
    return normalizeTextTransformers(JSON.parse(value));
  } catch {
    return [];
  }
}

function readTextTransformers() {
  const stored = storageGetJSON(StorageKeys.settings.textTransformers);
  const normalized = normalizeTextTransformers(stored);
  if (stored !== null && !isSerializedEqual(stored, normalized)) {
    storageSetJSON(StorageKeys.settings.textTransformers, normalized);
  }
  return normalized;
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

function readForgePanelButton() {
  const current = storageGet(StorageKeys.settings.showForgePanelButton);
  if (current !== null) return current !== 'false';
  return storageGet(StorageKeys.settings.showForgeButton) !== 'false';
}

const enterToSend = ref(storageGet(StorageKeys.settings.enterToSend) === 'true');
const suppressAutoWindows = ref(storageGet(StorageKeys.settings.suppressAutoWindows) === 'true');
const showMinimizeButtons = ref(storageGet(StorageKeys.settings.showMinimizeButtons) !== 'false');
const showCodexButton = ref(storageGet(StorageKeys.settings.showCodexButton) === 'true');
const showForgePanelButton = ref(readForgePanelButton());
const showForgeButton = showForgePanelButton;
const showCodexInStatusMonitor = ref(
  storageGet(StorageKeys.settings.showCodexInStatusMonitor) !== 'false',
);
const editInVis = ref(storageGet(StorageKeys.settings.editInVis) === 'true');
const dockAlwaysOpen = ref(storageGet(StorageKeys.settings.dockAlwaysOpen) === 'true');
const terminalFontFamily = ref(readTerminalFontFamily());
const appMonospaceFontFamily = ref(readAppMonospaceFontFamily());
const terminalFontSizePx = ref(readTerminalFontSizePx());
const appFontSizePx = ref(readAppFontSizePx());
const messageFontSizePx = ref(readMessageFontSizePx());
const sidebarFontSizePx = ref(readSidebarFontSizePx());
const uiFontSizePx = ref(readUiFontSizePx());
const showOpenInEditorButton = ref(
  storageGet(StorageKeys.settings.showOpenInEditorButton) !== 'false',
);
const openInEditorMaxSizeMb = ref(readOpenInEditorMaxSizeMb());
const floatingPreviewWordWrap = ref(
  storageGet(StorageKeys.settings.floatingPreviewWordWrap) === 'true',
);
const editorFontSizePx = ref(readEditorFontSizePx());
const editorTabSize = ref(readEditorTabSize());
const editorShortcuts = ref<EditorShortcutMap>(readEditorShortcuts());
const textTransformersEnabled = ref(
  storageGet(StorageKeys.settings.textTransformersEnabled) === 'true',
);
const textTransformers = ref<TextTransformer[]>(readTextTransformers());
const localApplicationPath = ref(storageGet(StorageKeys.settings.localApplicationPath) ?? '');
const themeStorage = ref<ThemeStorageV2 | null>(readThemeStorage());
const externalThemes = ref<ExternalThemeDefinition[]>(readExternalThemes());

const syncWatchOptions = { flush: 'sync' as const };

function persistBooleanSetting(setting: Ref<boolean>, key: string) {
  watch(
    setting,
    (value) => {
      storageSet(key, String(value));
    },
    syncWatchOptions,
  );
}

persistBooleanSetting(enterToSend, StorageKeys.settings.enterToSend);
persistBooleanSetting(suppressAutoWindows, StorageKeys.settings.suppressAutoWindows);
persistBooleanSetting(showMinimizeButtons, StorageKeys.settings.showMinimizeButtons);
persistBooleanSetting(showCodexButton, StorageKeys.settings.showCodexButton);
persistBooleanSetting(showCodexInStatusMonitor, StorageKeys.settings.showCodexInStatusMonitor);
persistBooleanSetting(editInVis, StorageKeys.settings.editInVis);

watch(
  showMinimizeButtons,
  (value) => {
    if (value) return;
    dockAlwaysOpen.value = false;
  },
  syncWatchOptions,
);

watch(
  showForgeButton,
  (value) => {
    storageSet(StorageKeys.settings.showForgePanelButton, String(value));
    storageSet(StorageKeys.settings.showForgeButton, String(value));
  },
  syncWatchOptions,
);

watch(
  dockAlwaysOpen,
  (value) => {
    storageSet(StorageKeys.settings.dockAlwaysOpen, String(value));
  },
  syncWatchOptions,
);

watch(
  terminalFontFamily,
  (value) => {
    const normalized = normalizeFontFamily(value, DEFAULT_TERMINAL_FONT_FAMILY);
    if (normalized !== value) {
      terminalFontFamily.value = normalized;
      return;
    }
    storageSet(StorageKeys.settings.terminalFontFamily, normalized);
  },
  syncWatchOptions,
);

watch(
  appMonospaceFontFamily,
  (value) => {
    const normalized = normalizeFontFamily(value, DEFAULT_APP_MONOSPACE_FONT_FAMILY);
    if (normalized !== value) {
      appMonospaceFontFamily.value = normalized;
      return;
    }
    storageSet(StorageKeys.settings.appMonospaceFontFamily, normalized);
  },
  syncWatchOptions,
);

watch(
  terminalFontSizePx,
  (value) => {
    storageSet(StorageKeys.settings.terminalFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  appFontSizePx,
  (value) => {
    storageSet(StorageKeys.settings.appFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  messageFontSizePx,
  (value) => {
    storageSet(StorageKeys.settings.messageFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  sidebarFontSizePx,
  (value) => {
    storageSet(StorageKeys.settings.sidebarFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  uiFontSizePx,
  (value) => {
    storageSet(StorageKeys.settings.uiFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  showOpenInEditorButton,
  (value) => {
    storageSet(StorageKeys.settings.showOpenInEditorButton, String(value));
  },
  syncWatchOptions,
);

watch(
  openInEditorMaxSizeMb,
  (value) => {
    storageSet(StorageKeys.settings.openInEditorMaxSizeMb, String(value));
  },
  syncWatchOptions,
);

watch(
  floatingPreviewWordWrap,
  (value) => {
    storageSet(StorageKeys.settings.floatingPreviewWordWrap, String(value));
  },
  syncWatchOptions,
);

watch(
  editorFontSizePx,
  (value) => {
    if (value === null) {
      storageRemove(StorageKeys.settings.editorFontSizePx);
      return;
    }
    storageSet(StorageKeys.settings.editorFontSizePx, String(value));
  },
  syncWatchOptions,
);

watch(
  editorTabSize,
  (value) => {
    storageSet(StorageKeys.settings.editorTabSize, String(value));
  },
  syncWatchOptions,
);

watch(
  editorShortcuts,
  (value) => {
    const normalized = normalizeEditorShortcutMap(value);
    if (!isSerializedEqual(value, normalized)) {
      editorShortcuts.value = normalized;
      return;
    }
    if (isSerializedEqual(storageGetJSON(StorageKeys.settings.editorShortcuts), normalized)) return;
    storageSetJSON(StorageKeys.settings.editorShortcuts, normalized);
  },
  { deep: true, flush: 'sync' },
);

watch(
  textTransformersEnabled,
  (value) => {
    storageSet(StorageKeys.settings.textTransformersEnabled, String(value));
  },
  syncWatchOptions,
);

watch(
  textTransformers,
  (value) => {
    const normalized = normalizeTextTransformers(value);
    if (isSerializedEqual(storageGetJSON(StorageKeys.settings.textTransformers), normalized))
      return;
    storageSetJSON(StorageKeys.settings.textTransformers, normalized);
  },
  { deep: true, flush: 'sync' },
);

watch(
  localApplicationPath,
  (value) => {
    const normalized = value.trim();
    if (normalized === '') {
      storageRemove(StorageKeys.settings.localApplicationPath);
      return;
    }
    storageSet(StorageKeys.settings.localApplicationPath, normalized);
  },
  syncWatchOptions,
);

watch(
  externalThemes,
  (value) => {
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
  },
  { deep: true, flush: 'sync' },
);

type SettingsStorageEventHandler = (event: StorageEvent) => void;

const settingsStorageHandlers = new Map<string, SettingsStorageEventHandler>([
  [
    storageKey(StorageKeys.settings.enterToSend),
    (event) => {
      enterToSend.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.suppressAutoWindows),
    (event) => {
      suppressAutoWindows.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.showMinimizeButtons),
    (event) => {
      showMinimizeButtons.value = event.newValue !== 'false';
    },
  ],
  [
    storageKey(StorageKeys.settings.showCodexButton),
    (event) => {
      showCodexButton.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.showForgeButton),
    (event) => {
      showForgeButton.value = event.newValue !== 'false';
    },
  ],
  [
    storageKey(StorageKeys.settings.showForgePanelButton),
    (event) => {
      showForgePanelButton.value = event.newValue !== 'false';
    },
  ],
  [
    storageKey(StorageKeys.settings.showCodexInStatusMonitor),
    (event) => {
      showCodexInStatusMonitor.value = event.newValue !== 'false';
    },
  ],
  [
    storageKey(StorageKeys.settings.editInVis),
    (event) => {
      editInVis.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.dockAlwaysOpen),
    (event) => {
      dockAlwaysOpen.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.terminalFontFamily),
    (event) => {
      terminalFontFamily.value = normalizeFontFamily(
        event.newValue ?? '',
        DEFAULT_TERMINAL_FONT_FAMILY,
      );
    },
  ],
  [
    storageKey(StorageKeys.settings.appMonospaceFontFamily),
    (event) => {
      appMonospaceFontFamily.value = normalizeFontFamily(
        event.newValue ?? '',
        DEFAULT_APP_MONOSPACE_FONT_FAMILY,
      );
    },
  ],
  [
    storageKey(StorageKeys.settings.terminalFontSizePx),
    (event) => {
      const parsed =
        event.newValue === null ? DEFAULT_TERMINAL_FONT_SIZE_PX : Number(event.newValue);
      terminalFontSizePx.value = normalizeTerminalFontSizePx(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.appFontSizePx),
    (event) => {
      const parsed = event.newValue === null ? DEFAULT_APP_FONT_SIZE_PX : Number(event.newValue);
      appFontSizePx.value = normalizeAppFontSizePx(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.messageFontSizePx),
    (event) => {
      const parsed =
        event.newValue === null ? DEFAULT_MESSAGE_FONT_SIZE_PX : Number(event.newValue);
      messageFontSizePx.value = normalizeMessageFontSizePx(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.sidebarFontSizePx),
    (event) => {
      const parsed =
        event.newValue === null ? DEFAULT_SIDEBAR_FONT_SIZE_PX : Number(event.newValue);
      sidebarFontSizePx.value = normalizeSidebarFontSizePx(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.uiFontSizePx),
    (event) => {
      const parsed = event.newValue === null ? DEFAULT_UI_FONT_SIZE_PX : Number(event.newValue);
      uiFontSizePx.value = normalizeUiFontSizePx(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.showOpenInEditorButton),
    (event) => {
      showOpenInEditorButton.value = event.newValue !== 'false';
    },
  ],
  [
    storageKey(StorageKeys.settings.openInEditorMaxSizeMb),
    (event) => {
      const parsed =
        event.newValue === null ? DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB : Number(event.newValue);
      openInEditorMaxSizeMb.value = normalizeOpenInEditorMaxSizeMb(parsed);
    },
  ],
  [
    storageKey(StorageKeys.settings.floatingPreviewWordWrap),
    (event) => {
      floatingPreviewWordWrap.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.editorFontSizePx),
    (event) => {
      editorFontSizePx.value =
        event.newValue === null ? null : normalizeEditorFontSizePx(Number(event.newValue));
    },
  ],
  [
    storageKey(StorageKeys.settings.editorTabSize),
    (event) => {
      editorTabSize.value =
        event.newValue === null
          ? DEFAULT_EDITOR_TAB_SIZE
          : normalizeEditorTabSize(Number(event.newValue));
    },
  ],
  [
    storageKey(StorageKeys.settings.editorShortcuts),
    () => {
      const nextShortcuts = readEditorShortcuts();
      if (!isSerializedEqual(editorShortcuts.value, nextShortcuts)) {
        editorShortcuts.value = nextShortcuts;
      }
    },
  ],
  [
    storageKey(StorageKeys.settings.textTransformersEnabled),
    (event) => {
      textTransformersEnabled.value = event.newValue === 'true';
    },
  ],
  [
    storageKey(StorageKeys.settings.textTransformers),
    (event) => {
      const nextTextTransformers = parseTextTransformers(event.newValue);
      if (!isSerializedEqual(textTransformers.value, nextTextTransformers)) {
        textTransformers.value = nextTextTransformers;
      }
    },
  ],
  [
    storageKey(StorageKeys.settings.localApplicationPath),
    (event) => {
      localApplicationPath.value = event.newValue ?? '';
    },
  ],
  [
    storageKey(StorageKeys.settings.themeTokens),
    () => {
      const nextThemeStorage = normalizeThemeStorage(
        storageGetJSON(StorageKeys.settings.themeTokens),
      );
      if (!isSerializedEqual(themeStorage.value, nextThemeStorage)) {
        themeStorage.value = nextThemeStorage;
      }
    },
  ],
  [
    storageKey(StorageKeys.settings.themeRegistry),
    () => {
      const nextExternalThemes = normalizeStoredExternalThemes(
        storageGetJSON(StorageKeys.settings.themeRegistry),
      );
      if (!isSerializedEqual(externalThemes.value, nextExternalThemes)) {
        externalThemes.value = nextExternalThemes;
      }
    },
  ],
]);

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    settingsStorageHandlers.get(event.key ?? '')?.(event);
  });
}

export function useSettings() {
  return {
    enterToSend,
    suppressAutoWindows,
    showMinimizeButtons,
    showCodexButton,
    showForgePanelButton,
    showForgeButton,
    showCodexInStatusMonitor,
    editInVis,
    dockAlwaysOpen,
    terminalFontFamily,
    appMonospaceFontFamily,
    themeStorage,
    externalThemes,
    showOpenInEditorButton,
    openInEditorMaxSizeMb,
    floatingPreviewWordWrap,
    editorFontSizePx,
    editorTabSize,
    editorShortcuts,
    textTransformersEnabled,
    textTransformers,
    localApplicationPath,
    defaultEditorShortcuts: DEFAULT_EDITOR_SHORTCUTS,
    minEditorFontSizePx: MIN_EDITOR_FONT_SIZE_PX,
    maxEditorFontSizePx: MAX_EDITOR_FONT_SIZE_PX,
    minEditorTabSize: MIN_EDITOR_TAB_SIZE,
    maxEditorTabSize: MAX_EDITOR_TAB_SIZE,
    defaultOpenInEditorMaxSizeMb: DEFAULT_OPEN_IN_EDITOR_MAX_SIZE_MB,
    minOpenInEditorMaxSizeMb: MIN_OPEN_IN_EDITOR_MAX_SIZE_MB,
    maxOpenInEditorMaxSizeMb: MAX_OPEN_IN_EDITOR_MAX_SIZE_MB,
    defaultTerminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaultAppMonospaceFontFamily: DEFAULT_APP_MONOSPACE_FONT_FAMILY,
    terminalFontSizePx,
    appFontSizePx,
    messageFontSizePx,
    sidebarFontSizePx,
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
    defaultSidebarFontSizePx: DEFAULT_SIDEBAR_FONT_SIZE_PX,
    minSidebarFontSizePx: MIN_SIDEBAR_FONT_SIZE_PX,
    maxSidebarFontSizePx: MAX_SIDEBAR_FONT_SIZE_PX,
    defaultUiFontSizePx: DEFAULT_UI_FONT_SIZE_PX,
    minUiFontSizePx: MIN_UI_FONT_SIZE_PX,
    maxUiFontSizePx: MAX_UI_FONT_SIZE_PX,
  };
}
