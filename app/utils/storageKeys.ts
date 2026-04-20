const STORAGE_PREFIX = 'opencode.';

type StorageBackend = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

let hasMigratedElectronStorage = false;

function migrateLocalStorageToElectronStorage(electronStorage: StorageBackend) {
  if (hasMigratedElectronStorage || typeof window === 'undefined') return;
  hasMigratedElectronStorage = true;

  const localStorage = window.localStorage;
  if (!localStorage) return;

  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(STORAGE_PREFIX)) {
        continue;
      }

      if (electronStorage.getItem(key) !== null) {
        continue;
      }

      const value = localStorage.getItem(key);
      if (value !== null) {
        electronStorage.setItem(key, value);
      }
    }
  } catch {
    return;
  }
}

function resolveStorageBackend(): StorageBackend | null {
  if (typeof window === 'undefined') return null;

  const electronStorage = window.electronAPI?.persistentStorage;
  if (electronStorage) {
    migrateLocalStorageToElectronStorage(electronStorage);
    return electronStorage;
  }

  return window.localStorage;
}

export const StorageKeys = {
  settings: {
    enterToSend: 'settings.enterToSend.v1',
    suppressAutoWindows: 'settings.suppressAutoWindows.v1',
    showMinimizeButtons: 'settings.showMinimizeButtons.v1',
    dockAlwaysOpen: 'settings.dockAlwaysOpen.v1',
    pinnedSessionsLimit: 'settings.pinnedSessionsLimit.v1',
    terminalFontFamily: 'settings.terminalFontFamily.v1',
    appMonospaceFontFamily: 'settings.appMonospaceFontFamily.v1',
    terminalFontSizePx: 'settings.terminalFontSizePx.v1',
    appFontSizePx: 'settings.appFontSizePx.v1',
    messageFontSizePx: 'settings.messageFontSizePx.v1',
    uiFontSizePx: 'settings.uiFontSizePx.v1',
    showOpenInEditorButton: 'settings.showOpenInEditorButton.v1',
    openInEditorMaxSizeMb: 'settings.openInEditorMaxSizeMb.v1',
    floatingPreviewWordWrap: 'settings.floatingPreviewWordWrap.v1',
    regionTheme: 'settings.regionTheme.v1',
    themeTokens: 'settings.themeTokens.v2',
    themeRegistry: 'settings.themeRegistry.v1',
  },
  state: {
    sidePanelCollapsed: 'state.sidePanelCollapsed.v1',
    sidePanelTab: 'state.sidePanelTab.v1',
    pinnedSessions: 'state.pinnedSessions.v1',
    lastAuthError: 'state.lastAuthError.v1',
    deletedSandboxes: 'state.deletedSandboxes.v1',
  },
  drafts: {
    composer: 'drafts.composer.v1',
    question: 'drafts.question.v1',
  },
  favorites: {
    messages: 'favorites.messages.v1',
  },
  auth: {
    credentials: 'auth.credentials.v1',
    serverUrl: 'auth.serverUrl.v1',
  },
} as const;

export function storageKey(key: string) {
  return `${STORAGE_PREFIX}${key}`;
}

export function storageGet(key: string) {
  const storage = resolveStorageBackend();
  if (!storage) return null;
  try {
    return storage.getItem(storageKey(key));
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string) {
  const storage = resolveStorageBackend();
  if (!storage) return;
  try {
    storage.setItem(storageKey(key), value);
  } catch {
    return;
  }
}

export function storageRemove(key: string) {
  const storage = resolveStorageBackend();
  if (!storage) return;
  try {
    storage.removeItem(storageKey(key));
  } catch {
    return;
  }
}

export function storageGetJSON<T>(key: string): T | null {
  const raw = storageGet(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function storageSetJSON(key: string, value: unknown) {
  storageSet(key, JSON.stringify(value));
}
