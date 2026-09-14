import type { PersistentStorage, PersistentStorageChange } from './persistentStorage.js';

export interface PersistentStorageIpcEvent {
  readonly sender: { readonly id: number };
  returnValue: unknown;
}

export interface PersistentStorageIpcOptions {
  readonly ipcMain: {
    on(
      channel: string,
      listener: (event: PersistentStorageIpcEvent, payload: unknown) => void,
    ): unknown;
  };
  readonly assertTrustedRenderer: (event: PersistentStorageIpcEvent) => void;
  readonly getStorage: () => PersistentStorage;
  readonly broadcastChange: (change: PersistentStorageChange, sourceWebContentsId?: number) => void;
  readonly getLocalApplicationPath: () => string | null;
  readonly localApplicationPathKey: string;
  readonly rendererStoragePrefix: string;
}

export function registerPersistentStorageIpc(options: PersistentStorageIpcOptions): void;
