export function registerSessionDatabaseIpc({ ipcMain, assertTrustedRenderer, getStorage, getLegacyExportStorage, broadcastHistoryChange }) {
  if (getLegacyExportStorage) for (const method of ['exportOpen', 'exportPage', 'exportBinding']) {
    ipcMain.handle(`session-database-${method}`, async (event, payload) => {
      assertTrustedRenderer(event);
      const exporter = getLegacyExportStorage();
      try { return await exporter[method](payload); }
      finally { await exporter.close(); }
    });
  }
  for (const method of ['readHistory', 'upsertHistory', 'clearHistory', 'flush']) {
    ipcMain.handle(`session-database-${method}`, async (event, payload) => {
      assertTrustedRenderer(event);
      if (method !== 'flush' && (!payload || typeof payload !== 'object' || typeof payload.threadId !== 'string')) {
        throw new TypeError('Invalid session database request');
      }
      const result = await getStorage()[method](payload);
      if (method === 'upsertHistory' || method === 'clearHistory') broadcastHistoryChange(payload.namespace && payload.namespace !== 'legacy-thread-id' ? JSON.stringify([payload.namespace, payload.threadId]) : payload.threadId, event.sender.id);
      return result;
    });
  }
}
