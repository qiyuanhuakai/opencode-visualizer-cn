const STORAGE_PREFIX = 'opencode.';
const LOCAL_STORAGE_OWNED_KEYS = new Set([
  'opencode.global.dat:model',
  'opencode.settings.disabledModels.v1',
]);

export type StorageReadResult =
  | { kind: 'value'; value: string }
  | { kind: 'missing' }
  | { kind: 'error' };

type StorageBackend = {
  readItem: (key: string) => StorageReadResult;
  setItem: (key: string, value: string) => boolean | void;
  removeItem: (key: string) => boolean | void;
};

type ElectronStorageBackend = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => boolean | void;
  removeItem: (key: string) => boolean | void;
  migrate: (entries: Record<string, string>) => boolean;
};

let hasMigratedElectronStorage = false;
let nextElectronStorageMigrationAttemptAt = 0;
const ELECTRON_STORAGE_MIGRATION_RETRY_MS = 1_000;

function readStorageItem(readItem: () => string | null): StorageReadResult {
  try {
    const value = readItem();
    return value === null ? { kind: 'missing' } : { kind: 'value', value };
  } catch {
    return { kind: 'error' };
  }
}

function createLocalStorageBackend(localStorage: Storage): StorageBackend {
  return {
    readItem: (key) => readStorageItem(() => localStorage.getItem(key)),
    setItem: (key, value) => {
      localStorage.setItem(key, value);
      return true;
    },
    removeItem: (key) => {
      localStorage.removeItem(key);
      return true;
    },
  };
}

function createElectronStorageBackend(electronStorage: ElectronStorageBackend): StorageBackend {
  return {
    readItem: (key) => readStorageItem(() => electronStorage.getItem(key)),
    setItem: (key, value) => electronStorage.setItem(key, value),
    removeItem: (key) => electronStorage.removeItem(key),
  };
}

function migrateLocalStorageToElectronStorage(
  electronStorage: ElectronStorageBackend,
  localStorage: Storage,
) {
  if (hasMigratedElectronStorage) return true;
  const now = Date.now();
  if (now < nextElectronStorageMigrationAttemptAt) return false;
  try {
    const entries: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(STORAGE_PREFIX) || LOCAL_STORAGE_OWNED_KEYS.has(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) entries[key] = value;
    }
    if (!electronStorage.migrate(entries)) {
      nextElectronStorageMigrationAttemptAt = now + ELECTRON_STORAGE_MIGRATION_RETRY_MS;
      return false;
    }
    for (const [key, migratedValue] of Object.entries(entries)) {
      const currentValue = localStorage.getItem(key);
      if (currentValue === migratedValue) {
        localStorage.removeItem(key);
      } else if (currentValue !== null) {
        nextElectronStorageMigrationAttemptAt = now + ELECTRON_STORAGE_MIGRATION_RETRY_MS;
        return false;
      }
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
  electronStorage: StorageBackend,
  localStorage: StorageBackend,
): StorageBackend {
  return {
    readItem: (key) => {
      const nativeValue = electronStorage.readItem(key);
      return nativeValue.kind === 'missing' ? localStorage.readItem(key) : nativeValue;
    },
    setItem: (key, value) => {
      const nativeValue = electronStorage.readItem(key);
      if (nativeValue.kind === 'error') return false;
      if (nativeValue.kind === 'value') {
        if (electronStorage.setItem(key, value) === false) return false;
        try {
          localStorage.setItem(key, value);
        } catch {
          return true;
        }
        return true;
      }
      return false;
    },
    removeItem: (key) => {
      const nativeValue = electronStorage.readItem(key);
      if (nativeValue.kind === 'error') return false;
      if (nativeValue.kind === 'value') {
        if (electronStorage.removeItem(key) === false) return false;
        try {
          localStorage.removeItem(key);
        } catch {
          return false;
        }
        return true;
      }
      return false;
    },
  };
}

function resolveStorageBackend(): StorageBackend | null {
  if (typeof window === 'undefined') return null;

  const electronStorage = window.electronAPI?.persistentStorage;
  if (electronStorage) {
    let localStorage: Storage;
    try {
      localStorage = window.localStorage;
    } catch {
      return createElectronStorageBackend(electronStorage);
    }
    const electronBackend = createElectronStorageBackend(electronStorage);
    const localBackend = createLocalStorageBackend(localStorage);
    return migrateLocalStorageToElectronStorage(electronStorage, localStorage)
      ? electronBackend
      : pendingElectronMigrationBackend(electronBackend, localBackend);
  }

  return createLocalStorageBackend(window.localStorage);
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
    codexTurnEfforts: 'state.codexTurnEfforts.v1',
    codexMessageModels: 'state.codexMessageModels.v1',
    codexThreadActivity: 'state.codexThreadActivity.v1',
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
  const result = storageRead(key);
  return result.kind === 'value' ? result.value : null;
}

export function storageRead(key: string): StorageReadResult {
  const storage = resolveStorageBackend();
  return storage?.readItem(storageKey(key)) ?? { kind: 'missing' };
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
