import { describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => ({
  beforeInstall: null as null | ((component: 'app' | 'bridge', signal: AbortSignal) => Promise<boolean>),
  closeLocalFiles: vi.fn(async () => undefined),
  showMessageBox: vi.fn(async () => ({ response: 0 })),
  shellDispose: vi.fn(),
  updateDispose: vi.fn(async () => undefined),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp') },
  BrowserWindow: class {},
  dialog: { showMessageBox: fixtures.showMessageBox },
  ipcMain: {},
  Menu: {},
  nativeImage: {},
  Notification: class {},
  shell: {},
  Tray: class {},
}));

vi.mock('../electron/persistentStorage.js', () => ({ createPersistentStorage: vi.fn(() => ({})) }));
vi.mock('../electron/desktopShell.js', () => ({
  createDesktopShell: vi.fn(() => ({
    attachWindow: vi.fn(),
    restore: vi.fn(),
    dispose: fixtures.shellDispose,
  })),
}));
vi.mock('../electron/updateService.js', () => ({
  createDesktopUpdates: vi.fn((options) => {
    fixtures.beforeInstall = options.beforeInstall;
    return { dispose: fixtures.updateDispose };
  }),
}));
vi.mock('../electron/desktopController.js', () => ({
  createDesktopController: vi.fn(() => ({
    getState: () => ({
      preferences: { locale: 'en' },
      updates: { app: { phase: 'downloaded', installKind: 'automatic' } },
    }),
    start: vi.fn(),
  })),
  registerDesktopIpc: vi.fn(),
}));

const { createDesktopRuntime } = (await import('../electron/desktopRuntime.js' as string)) as {
  createDesktopRuntime(options: {
    getWindow: () => null;
    assertTrustedRenderer: ReturnType<typeof vi.fn>;
    closeLocalFiles: () => Promise<void>;
  }): { dispose(): Promise<void> };
};

describe('desktop runtime shutdown', () => {
  it('uses an explicit native cancel response and preserves the downloaded installer', async () => {
    // Given: the native confirmation dialog resolves through its cancel button.
    createRuntime();
    const controller = new AbortController();

    // When: the update service asks to install a downloaded bridge package.
    const approved = await fixtures.beforeInstall?.('bridge', controller.signal);

    // Then: cancellation is explicit, abort-aware, and does not start app cleanup.
    expect(approved).toBe(false);
    expect(fixtures.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ cancelId: 0, signal: controller.signal }));
    expect(fixtures.closeLocalFiles).not.toHaveBeenCalled();
  });

  it('exposes idempotent awaited disposal for the main quit gate', async () => {
    // Given: a desktop runtime with both shell and update resources.
    const runtime = createRuntime();

    // When: the main process requests disposal more than once.
    const first = runtime.dispose();
    const second = runtime.dispose();

    // Then: shell resources close immediately and updater cleanup is shared and awaited.
    expect(second).toBe(first);
    await expect(first).resolves.toBeUndefined();
    expect(fixtures.shellDispose).toHaveBeenCalledOnce();
    expect(fixtures.updateDispose).toHaveBeenCalledOnce();
  });
});

function createRuntime() {
  return createDesktopRuntime({
    getWindow: () => null,
    assertTrustedRenderer: vi.fn(),
    closeLocalFiles: fixtures.closeLocalFiles,
  });
}
