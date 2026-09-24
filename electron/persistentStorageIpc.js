export function registerPersistentStorageIpc({
  ipcMain,
  assertTrustedRenderer,
  getStorage,
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
    const storage = getStorage();
    await storage.setItemAsync(payload.key, payload.value);
    for (const change of storage.drainPendingChanges()) {
      broadcastChange(change, change.key === payload.key ? event.sender.id : undefined);
    }
    return true;
  });

  function commitMutation(event, mutation, excludedKey) {
    let changes;
    try {
      const storage = getStorage();
      mutation(storage);
      changes = storage.drainPendingChanges();
    } catch {
      event.returnValue = false;
      return;
    }
    for (const change of changes) {
      const excludedSenderId = change.key === excludedKey ? event.sender.id : undefined;
      broadcastChange(change, excludedSenderId);
    }
    event.returnValue = true;
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
      event.returnValue = { ok: true, value: getStorage().getItem(key) };
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
    commitMutation(event, (storage) => storage.setItem(key, value), key);
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
    commitMutation(event, (storage) => storage.removeItem(key), key);
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
    commitMutation(event, (storage) => storage.migrate(migrationEntries));
  });
}
