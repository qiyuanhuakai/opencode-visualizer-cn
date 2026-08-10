export type QuitEvent = { preventDefault(): void };
export type QuitCleanupApp = {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): void;
  quit(): void;
};

export function installAsyncQuitCleanup(
  app: QuitCleanupApp,
  cleanup: () => Promise<void>,
  onError?: (error: unknown) => void,
): void;
