export type QuitEvent = { preventDefault(): void };
export type QuitCleanupApp = {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): void;
  quit(): void;
};

export type LocalFileEditorCleanupOwner = {
  closeAll(): Promise<void>;
};

export type DesktopRuntimeCleanupOwner = {
  dispose(): Promise<void>;
};

export function cleanupAsyncQuitOwners(
  localFileEditor: LocalFileEditorCleanupOwner,
  desktopRuntime: DesktopRuntimeCleanupOwner | null | undefined,
): Promise<[void, void | undefined]>;

export function installAsyncQuitCleanup(
  app: QuitCleanupApp,
  cleanup: () => Promise<void>,
  onError?: (error: unknown) => void,
): void;
