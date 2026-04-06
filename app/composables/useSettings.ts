import { ref, watch } from 'vue';
import { StorageKeys, storageGet, storageKey, storageSet } from '../utils/storageKeys';

const DEFAULT_PINNED_SESSIONS_LIMIT = 30;
const MIN_PINNED_SESSIONS_LIMIT = 1;
const MAX_PINNED_SESSIONS_LIMIT = 200;
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

const enterToSend = ref(storageGet(StorageKeys.settings.enterToSend) === 'true');
const suppressAutoWindows = ref(storageGet(StorageKeys.settings.suppressAutoWindows) === 'true');
const showMinimizeButtons = ref(storageGet(StorageKeys.settings.showMinimizeButtons) !== 'false');
const dockAlwaysOpen = ref(storageGet(StorageKeys.settings.dockAlwaysOpen) === 'true');
const pinnedSessionsLimit = ref(readPinnedSessionsLimit());
const terminalFontFamily = ref(readTerminalFontFamily());
const appMonospaceFontFamily = ref(readAppMonospaceFontFamily());

watch(enterToSend, (value) => {
  storageSet(StorageKeys.settings.enterToSend, String(value));
});

watch(suppressAutoWindows, (value) => {
  storageSet(StorageKeys.settings.suppressAutoWindows, String(value));
});

watch(showMinimizeButtons, (value) => {
  storageSet(StorageKeys.settings.showMinimizeButtons, String(value));
});

watch(dockAlwaysOpen, (value) => {
  storageSet(StorageKeys.settings.dockAlwaysOpen, String(value));
});

watch(showMinimizeButtons, (value) => {
  if (value) return;
  dockAlwaysOpen.value = false;
});

watch(pinnedSessionsLimit, (value) => {
  const normalized = normalizePinnedSessionsLimit(value);
  if (normalized !== value) {
    pinnedSessionsLimit.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.pinnedSessionsLimit, String(normalized));
});

watch(terminalFontFamily, (value) => {
  const normalized = normalizeFontFamily(value, DEFAULT_TERMINAL_FONT_FAMILY);
  if (normalized !== value) {
    terminalFontFamily.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.terminalFontFamily, normalized);
});

watch(appMonospaceFontFamily, (value) => {
  const normalized = normalizeFontFamily(value, DEFAULT_APP_MONOSPACE_FONT_FAMILY);
  if (normalized !== value) {
    appMonospaceFontFamily.value = normalized;
    return;
  }
  storageSet(StorageKeys.settings.appMonospaceFontFamily, normalized);
});

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
    defaultPinnedSessionsLimit: DEFAULT_PINNED_SESSIONS_LIMIT,
    minPinnedSessionsLimit: MIN_PINNED_SESSIONS_LIMIT,
    maxPinnedSessionsLimit: MAX_PINNED_SESSIONS_LIMIT,
    defaultTerminalFontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
    defaultAppMonospaceFontFamily: DEFAULT_APP_MONOSPACE_FONT_FAMILY,
  };
}
