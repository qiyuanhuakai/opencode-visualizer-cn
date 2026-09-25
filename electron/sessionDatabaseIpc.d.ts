import type { SessionStorage } from './sessionStorage.js';
import type { PersistentStorageIpcEvent } from './persistentStorageIpc.js';
export function registerSessionDatabaseIpc(options: Readonly<{
  ipcMain: { handle(channel: string, handler: (event: PersistentStorageIpcEvent, payload: unknown) => Promise<unknown>): unknown };
  assertTrustedRenderer: (event: PersistentStorageIpcEvent) => void;
  getStorage: () => SessionStorage;
  broadcastHistoryChange: (threadId: string, sourceId: number) => void;
}>): void;
