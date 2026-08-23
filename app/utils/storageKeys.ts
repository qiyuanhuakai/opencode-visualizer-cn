const STORAGE_PREFIX = 'opencode.';

type StorageBackend = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => boolean | void;
  removeItem: (key: string) => boolean | void;
};

type ElectronStorageBackend = StorageBackend & {
  migrate: (entries: Record<string, string>) => boolean;
};

let hasMigratedElectronStorage = false;
let nextElectronStorageMigrationAttemptAt = 0;
const ELECTRON_STORAGE_MIGRATION_RETRY_MS = 1_000;

function migrateLocalStorageToElectronStorage(
  electronStorage: ElectronStorageBackend,
  localStorage: Storage,
) {
  if (hasMigratedElectronStorage) return true;
  if (typeof window === 'undefined') return false;
  const now = Date.now();
  if (now < nextElectronStorageMigrationAttemptAt) return false;
  try {
    const entries: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    if (!electronStorage.migrate(entries)) {
      nextElectronStorageMigrationAttemptAt = now + ELECTRON_STORAGE_MIGRATION_RETRY_MS;
      return false;
    }
    hasMigratedElectronStorage = true;
    nextElectronStorageMigrationAttemptAt = 0;
    return true;
  } catch {
    nextElectronStorageMigrationAttemptAt = now + ELECTRON_STORAGE_MIGRATION_RETRY_MS;
    return false;
  }
}

function pendingElectronMigrationBackend(
  electronStorage: ElectronStorageBackend,
  localStorage: StorageBackend,
): StorageBackend {
  return {
    getItem: (key) => electronStorage.getItem(key) ?? localStorage.getItem(key),
    setItem: () => false,
    removeItem: () => false,
  };
}

function resolveStorageBackend(): StorageBackend | null {
  if (typeof window === 'undefined') return null;

  const electronStorage = window.electronAPI?.persistentStorage;
  let localStorage: Storage;
  try {
    localStorage = window.localStorage;
  } catch {
    return electronStorage ?? null;
  }
  if (electronStorage) {
    return migrateLocalStorageToElectronStorage(electronStorage, localStorage)
      ? electronStorage
      : pendingElectronMigrationBackend(electronStorage, localStorage);
  }

  return localStorage;
}

export const StorageKeys = {
  settings: {
    enterToSend: 'settings.enterToSend.v1',
    suppressAutoWindows: 'settings.suppressAutoWindows.v1',
    showMinimizeButtons: 'settings.showMinimizeButtons.v1',
    dockAlwaysOpen: 'settings.dockAlwaysOpen.v1',
    terminalFontFamily: 'settings.terminalFontFamily.v1',
    appMonospaceFontFamily: 'settings.appMonospaceFontFamily.v1',
    terminalFontSizePx: 'settings.terminalFontSizePx.v1',
    appFontSizePx: 'settings.appFontSizePx.v1',
    messageFontSizePx: 'settings.messageFontSizePx.v1',
    sidebarFontSizePx: 'settings.sidebarFontSizePx.v1',
    uiFontSizePx: 'settings.uiFontSizePx.v1',
    showOpenInEditorButton: 'settings.showOpenInEditorButton.v1',
    openInEditorMaxSizeMb: 'settings.openInEditorMaxSizeMb.v1',
    floatingPreviewWordWrap: 'settings.floatingPreviewWordWrap.v1',
    showCodexButton: 'settings.showCodexButton.v1',
    showForgePanelButton: 'settings.showForgePanelButton.v1',
    showForgeButton: 'settings.showForgeButton.v1',
    showCodexInStatusMonitor: 'settings.showCodexInStatusMonitor.v1',
    editInVis: 'settings.editInVis.v1',
    editorFontSizePx: 'settings.editorFontSizePx.v1',
    editorTabSize: 'settings.editorTabSize.v1',
    editorShortcuts: 'settings.editorShortcuts.v1',
    textTransformersEnabled: 'settings.textTransformersEnabled.v1',
    textTransformers: 'settings.textTransformers.v1',
    localApplicationPath: 'settings.localApplicationPath.v1',
    regionTheme: 'settings.regionTheme.v1',
    themeTokens: 'settings.themeTokens.v2',
    themeRegistry: 'settings.themeRegistry.v1',
  },
  state: {
    sidePanelCollapsed: 'state.sidePanelCollapsed.v1',
    sidePanelTab: 'state.sidePanelTab.v1',
    pinnedSessions: 'state.pinnedSessions.v1',
    sessionTreeExpanded: 'state.sessionTreeExpanded.v1',
    lastAuthError: 'state.lastAuthError.v1',
    deletedSandboxes: 'state.deletedSandboxes.v1',
    codexActiveThread: 'state.codexActiveThread.v1',
    codexPanelConnected: 'state.codexPanelConnected.v1',
    codexAuxiliaryHistory: 'state.codexAuxiliaryHistory.v1',
    forgePtyId: 'state.forgePtyId.v1',
    acpArchivedSessions: 'state.acpArchivedSessions.v1',
    acpMessageAttribution: 'state.acpMessageAttribution.v1',
    openCodeLastSelection: 'state.openCodeLastSelection.v1',
  },
  drafts: {
    composer: 'drafts.composer.v1',
    question: 'drafts.question.v1',
  },
  favorites: {
    messages: 'favorites.messages.v1',
  },
  auth: {
    backendKind: 'auth.backendKind.v1',
    credentials: 'auth.credentials.v1',
    serverUrl: 'auth.serverUrl.v1',
    codexBridgeUrl: 'auth.codexBridgeUrl.v1',
    acpBridgeUrl: 'auth.acpBridgeUrl.v1',
    codexBridgeToken: 'auth.codexBridgeToken.v1',
    acpBridgeToken: 'auth.acpBridgeToken.v1',
    acpAgentId: 'auth.acpAgentId.v1',
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
  if (!storage) return false;
  try {
    return storage.setItem(storageKey(key), value) !== false;
  } catch {
    return false;
  }
}

export function storageRemove(key: string) {
  const storage = resolveStorageBackend();
  if (!storage) return false;
  try {
    return storage.removeItem(storageKey(key)) !== false;
  } catch {
    return false;
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
  return storageSet(key, JSON.stringify(value));
}
