import {
  APPROVED_APPLICATION_KEY,
  decodeLiveSetting,
  encodeLiveSetting,
  liveSettingKey,
  parseLiveSettingKey,
} from '../shared/runtime/liveSettings.js';

function isLiveNamespace(key) {
  return key.startsWith('vis.live-settings.');
}

export async function readConfiguredMaxLocalFileBytes(getStorage, getLiveStorage) {
  const logicalKey = 'settings.openInEditorMaxSizeMb.v1';
  const live = getLiveStorage().getItem(liveSettingKey(logicalKey));
  let raw;
  if (live === null) {
    raw = await getStorage().getItem(`opencode.${logicalKey}`);
  } else {
    const decoded = decodeLiveSetting(live);
    if (decoded.kind === 'error') throw new TypeError('Invalid live file size setting');
    raw = decoded.kind === 'value' ? decoded.value : null;
  }
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) return 20 * 1024 * 1024;
  return Math.min(Math.round(megabytes), 100) * 1024 * 1024;
}

export function registerPersistentStorageIpc({
  ipcMain,
  assertTrustedRenderer,
  getStorage,
  getLiveStorage,
  broadcastChange,
  getLocalApplicationPath,
  localApplicationPathKey,
  rendererStoragePrefix,
}) {
  ipcMain.handle('persistent-storage-set-async', async (event, payload) => {
    assertTrustedRenderer(event);
    if (typeof payload?.key !== 'string' || (typeof payload.value !== 'string' && payload.value !== null)) {
      throw new TypeError('Invalid asynchronous storage mutation');
    }
    if (isLiveNamespace(payload.key)) throw new TypeError('Live settings require synchronous storage');
    const storage = getStorage();
    await storage.setItemAsync(payload.key, payload.value);
    for (const change of storage.drainPendingChanges()) {
      broadcastChange(change, change.key === payload.key ? event.sender.id : undefined);
    }
    return true;
  });

  function commitMutation(event, mutation, excludedKey, storageProvider = getStorage) {
    const complete = (storage) => {
      for (const change of storage.drainPendingChanges()) {
        const excludedSenderId = change.key === excludedKey ? event.sender.id : undefined;
        broadcastChange(change, excludedSenderId);
      }
      event.returnValue = true;
    };
    try {
      const storage = storageProvider();
      const result = mutation(storage);
      if (result && typeof result.then === 'function') {
        return result.then(() => complete(storage), () => { event.returnValue = false; });
      }
      complete(storage);
    } catch {
      event.returnValue = false;
    }
  }

  ipcMain.on('persistent-storage-get', (event, key) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string') {
      event.returnValue = { ok: true, value: null };
      return;
    }
    if (key === localApplicationPathKey) {
      event.returnValue = { ok: true, value: getLocalApplicationPath() };
      return;
    }
    try {
      let storage;
      if (isLiveNamespace(key)) {
        const logicalKey = parseLiveSettingKey(key);
        if (logicalKey === null) throw new TypeError('Unknown live setting');
        if (logicalKey === APPROVED_APPLICATION_KEY) {
          event.returnValue = { ok: true, value: null };
          return;
        }
        storage = getLiveStorage();
      } else {
        storage = getStorage();
      }
      const value = storage.getItem(key);
      if (isLiveNamespace(key) && value !== null && decodeLiveSetting(value).kind === 'error') {
        throw new TypeError('Invalid live setting envelope');
      }
      if (value && typeof value.then === 'function') {
        return value.then((resolved) => { event.returnValue = { ok: true, value: resolved }; }, (error) => {
          event.returnValue = { ok: false, error: { name: error.name, message: error.message } };
        });
      }
      event.returnValue = { ok: true, value };
    } catch (error) {
      event.returnValue = {
        ok: false,
        error: {
          name: typeof error?.name === 'string' ? error.name : 'Error',
          message: typeof error?.message === 'string' ? error.message : String(error),
        },
      };
    }
  });

  ipcMain.on('persistent-storage-set', (event, payload) => {
    assertTrustedRenderer(event);
    const key = payload?.key;
    const value = payload?.value;
    if (typeof key !== 'string' || typeof value !== 'string') {
      event.returnValue = false;
      return;
    }
    if (key === localApplicationPathKey) {
      event.returnValue = true;
      return;
    }
    if (isLiveNamespace(key)) {
      const logicalKey = parseLiveSettingKey(key);
      if (logicalKey === null || logicalKey === APPROVED_APPLICATION_KEY || decodeLiveSetting(value).kind === 'error') {
        event.returnValue = false;
        return;
      }
      return commitMutation(event, (storage) => storage.setItem(key, value), key, () => getLiveStorage());
    }
    return commitMutation(event, (storage) => storage.setItem(key, value), key);
  });

  ipcMain.on('persistent-storage-remove', (event, key) => {
    assertTrustedRenderer(event);
    if (typeof key !== 'string') {
      event.returnValue = false;
      return;
    }
    if (key === localApplicationPathKey) {
      event.returnValue = true;
      return;
    }
    if (isLiveNamespace(key)) {
      const logicalKey = parseLiveSettingKey(key);
      if (logicalKey === null || logicalKey === APPROVED_APPLICATION_KEY) {
        event.returnValue = false;
        return;
      }
      return commitMutation(event, (storage) => storage.setItem(key, encodeLiveSetting(null)), key, () => getLiveStorage());
    }
    return commitMutation(event, (storage) => storage.removeItem(key), key);
  });

  ipcMain.on('persistent-storage-migrate', (event, entries) => {
    assertTrustedRenderer(event);
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      event.returnValue = false;
      return;
    }
    const migrationEntries = {};
    for (const [key, value] of Object.entries(entries)) {
      if (!key.startsWith(rendererStoragePrefix) || typeof value !== 'string') {
        event.returnValue = false;
        return;
      }
      if (key !== localApplicationPathKey) migrationEntries[key] = value;
    }
    return commitMutation(event, (storage) => storage.migrate(migrationEntries));
  });
}
