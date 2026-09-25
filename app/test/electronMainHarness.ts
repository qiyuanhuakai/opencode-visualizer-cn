import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

export type ElectronMainEvent = {
  readonly sender: { readonly id: number };
  returnValue?: unknown;
};

type EventListener = (...args: unknown[]) => unknown;
type IpcHandler = (event: ElectronMainEvent, payload?: unknown) => unknown;

const harness = vi.hoisted(() => {
  const appListeners = new Map<string, EventListener[]>();
  const ipcHandlers = new Map<string, IpcHandler>();
  const ipcListeners = new Map<string, IpcHandler>();
  const localFileDirectories: string[] = [];
  const sentMessages: Array<readonly [number, string, unknown]> = [];
  const windows: HarnessBrowserWindow[] = [];
  let userDataPath = '';

  class HarnessBrowserWindow {
    readonly webContents = {
      id: windows.length + 1,
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) =>
        sentMessages.push([this.webContents.id, channel, payload]),
      openDevTools: vi.fn(),
      session: {
        webRequest: { onHeadersReceived: vi.fn() },
        setPermissionRequestHandler: vi.fn(),
      },
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    };

    constructor(_options: unknown) {
      windows.push(this);
    }

    static getAllWindows() {
      return windows;
    }

    focus = vi.fn();
    loadURL = vi.fn(async () => undefined);
    once = vi.fn();
    on = vi.fn();
    setEnabled = vi.fn();
    show = vi.fn();
  }

  const app = {
    getPath: vi.fn(() => userDataPath),
    getVersion: vi.fn(() => '1.0.0-test'),
    isPackaged: true,
    on: vi.fn((event: string, listener: EventListener) => {
      const listeners = appListeners.get(event) ?? [];
      listeners.push(listener);
      appListeners.set(event, listeners);
    }),
    quit: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(async () => undefined),
  };
  const createDesktopRuntime = vi.fn(() => ({
    attachWindow: vi.fn(),
    dispose: vi.fn(async () => undefined),
    restore: vi.fn(),
  }));

  return {
    app,
    appListeners,
    BrowserWindow: HarnessBrowserWindow,
    createDesktopRuntime,
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/bin/true'] })),
    },
    ipcHandlers,
    ipcListeners,
    localFileDirectories,
    sentMessages,
    setUserDataPath(pathname: string) {
      userDataPath = pathname;
    },
    windows,
  };
});

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.BrowserWindow,
  clipboard: { readText: vi.fn(() => ''), writeText: vi.fn() },
  dialog: harness.dialog,
  ipcMain: {
    handle: (channel: string, handler: IpcHandler) => harness.ipcHandlers.set(channel, handler),
    on: (channel: string, handler: IpcHandler) => harness.ipcListeners.set(channel, handler),
  },
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../../electron/desktopRuntime.js', () => ({
  createDesktopRuntime: harness.createDesktopRuntime,
}));

vi.mock('../../electron/sessionStorage.js', async () => {
  const { createPersistentStorage } = await import('../../electron/persistentStorage.js');
  return {
    createSessionStorage: (filePath: string) => {
      const storage = createPersistentStorage(filePath);
      return { ...storage, close: () => storage.flush() };
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const actualFileSystem = actual;
  return {
    ...actual,
    default: {
      ...actualFileSystem,
      promises: {
        ...actualFileSystem.promises,
        mkdtemp: async (prefix: string) => {
          const directory = await actualFileSystem.promises.mkdtemp(prefix);
          harness.localFileDirectories.push(directory);
          return directory;
        },
      },
    },
  };
});

export async function loadElectronMainHarness() {
  vi.resetModules();
  harness.appListeners.clear();
  harness.ipcHandlers.clear();
  harness.ipcListeners.clear();
  harness.localFileDirectories.splice(0);
  harness.sentMessages.splice(0);
  harness.windows.splice(0);
  harness.app.quit.mockClear();
  harness.createDesktopRuntime.mockClear();
  harness.dialog.showOpenDialog.mockClear();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'vis-electron-main-'));
  harness.setUserDataPath(userDataPath);

  await import('../../electron/main.js');
  await vi.waitFor(() => {
    if (harness.windows.length !== 1) throw new Error('Electron main window was not created');
  });

  return {
    ...harness,
    cleanup: () => fs.rmSync(userDataPath, { recursive: true, force: true }),
    invoke: (channel: string, payload?: unknown, senderId = 1) => {
      const handler = harness.ipcHandlers.get(channel) ?? harness.ipcListeners.get(channel);
      if (!handler) throw new Error(`Missing Electron main handler: ${channel}`);
      const event: ElectronMainEvent = { sender: { id: senderId } };
      return { event, result: handler(event, payload) };
    },
  };
}
