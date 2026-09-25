export function registerSessionDatabaseIpc({ ipcMain, assertTrustedRenderer, getStorage, broadcastHistoryChange }) {
  for (const method of ['readHistory', 'upsertHistory', 'clearHistory', 'flush']) {
    ipcMain.handle(`session-database-${method}`, async (event, payload) => {
      assertTrustedRenderer(event);
      if (method !== 'flush' && (!payload || typeof payload !== 'object' || typeof payload.threadId !== 'string')) {
        throw new TypeError('Invalid session database request');
      }
      const result = await getStorage()[method](payload);
      if (method === 'upsertHistory' || method === 'clearHistory') broadcastHistoryChange(payload.threadId, event.sender.id);
      return result;
    });
  }
}
