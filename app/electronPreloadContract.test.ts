import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PRELOAD_PATH = path.resolve(__dirname, '../electron/preload.cjs');
const preloadSource = readFileSync(PRELOAD_PATH, 'utf8');

interface LocalFileChange {
  sessionId: string;
  content: string;
}

interface LocalFileError {
  sessionId: string;
  message: string;
}

interface ElectronApiSchema {
  platform: string;
  versions: { node: string; electron: string; chrome: string };
  getAppVersion: () => Promise<unknown>;
  getPlatform: () => Promise<unknown>;
  clipboard: { writeText: (text: string) => Promise<unknown> };
  localFile: {
    selectApplication: () => Promise<unknown>;
    clearApplication: () => Promise<unknown>;
    open: (payload: unknown) => Promise<unknown>;
    close: (sessionId: string) => Promise<unknown>;
    onChanged: (listener: (change: LocalFileChange) => void) => void;
    offChanged: (listener: (change: LocalFileChange) => void) => void;
    onError: (listener: (error: LocalFileError) => void) => void;
    offError: (listener: (error: LocalFileError) => void) => void;
  };
  persistentStorage: {
    getItem: (key: string) => unknown;
    setItem: (key: string, value: string) => unknown;
    removeItem: (key: string) => unknown;
  };
}

type IpcListener = (event: unknown, payload?: unknown) => void;

function createIpcRendererMock() {
  const listenersByChannel = new Map<string, IpcListener[]>();
  const invoke = vi.fn((_channel: string, ..._args: unknown[]) => Promise.resolve('invoked'));
  const sendSync = vi.fn((_channel: string, ..._args: unknown[]) => 'synced');
  const on = vi.fn((channel: string, listener: IpcListener) => {
    const listeners = listenersByChannel.get(channel) ?? [];
    listeners.push(listener);
    listenersByChannel.set(channel, listeners);
  });
  const emit = (channel: string, event: unknown, payload?: unknown) => {
    for (const listener of listenersByChannel.get(channel) ?? []) listener(event, payload);
  };
  return { invoke, sendSync, on, emit };
}

interface LoadedPreload {
  api: ElectronApiSchema;
  ipcRenderer: ReturnType<typeof createIpcRendererMock>;
  dispatchedEvents: Array<{ type: string; key: string | null; oldValue: string | null; newValue: string | null }>;
}

function loadPreloadWithMocks(): LoadedPreload {
  const ipcRenderer = createIpcRendererMock();
  const dispatchedEvents: LoadedPreload['dispatchedEvents'] = [];
  let capturedApi: ElectronApiSchema | undefined;

  const contextBridge = {
    exposeInMainWorld: vi.fn((_key: string, api: unknown) => {
      capturedApi = api as ElectronApiSchema;
    }),
  };

  const windowStub = {
    location: { href: 'app://index.html' },
    dispatchEvent: vi.fn((event: { type: string; key: string | null; oldValue: string | null; newValue: string | null }) => {
      dispatchedEvents.push({
        type: event.type,
        key: event.key,
        oldValue: event.oldValue,
        newValue: event.newValue,
      });
      return true;
    }),
  };

  vm.runInNewContext(
    preloadSource,
    {
      require: (id: string) => {
        if (id === 'electron') return { contextBridge, ipcRenderer };
        throw new Error(`preload requested unexpected module: ${id}`);
      },
      process: {
        platform: 'linux',
        versions: { node: '24.14.1', electron: '35.7.5', chrome: '134.0.7001.17' },
      },
      window: windowStub,
      StorageEvent: class StorageEventStub {
        readonly type: string;
        readonly key: string | null;
        readonly oldValue: string | null;
        readonly newValue: string | null;

        constructor(
          type: string,
          init?: { key?: string | null; oldValue?: string | null; newValue?: string | null },
        ) {
          this.type = type;
          this.key = init?.key ?? null;
          this.oldValue = init?.oldValue ?? null;
          this.newValue = init?.newValue ?? null;
        }
      },
      console,
    },
    { filename: 'electron/preload.cjs' },
  );

  if (capturedApi === undefined) {
    throw new Error('preload did not expose window.electronAPI via contextBridge');
  }

  return { api: capturedApi, ipcRenderer, dispatchedEvents };
}

describe('electron preload contract', () => {
  it('exposes exactly the trusted top-level api names', () => {
    const { api } = loadPreloadWithMocks();
    expect(Object.keys(api).sort()).toEqual([
      'clipboard',
      'getAppVersion',
      'getPlatform',
      'localFile',
      'persistentStorage',
      'platform',
      'versions',
    ]);
  });

  it('exposes the exact clipboard api name', () => {
    const { api } = loadPreloadWithMocks();
    expect(Object.keys(api.clipboard).sort()).toEqual(['writeText']);
  });

  it('exposes exactly the localFile api names', () => {
    const { api } = loadPreloadWithMocks();
    expect(Object.keys(api.localFile).sort()).toEqual([
      'clearApplication',
      'close',
      'offChanged',
      'offError',
      'onChanged',
      'onError',
      'open',
      'selectApplication',
    ]);
  });

  it('exposes exactly the persistentStorage api names', () => {
    const { api } = loadPreloadWithMocks();
    expect(Object.keys(api.persistentStorage).sort()).toEqual(['getItem', 'removeItem', 'setItem']);
  });

  it('exposes the platform and version metadata', () => {
    const { api } = loadPreloadWithMocks();
    expect(api.platform).toBe('linux');
    expect(api.versions).toEqual({ node: '24.14.1', electron: '35.7.5', chrome: '134.0.7001.17' });
  });

  it('routes getAppVersion and getPlatform through ipcRenderer.invoke', async () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    await expect(api.getAppVersion()).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-app-version');
    await expect(api.getPlatform()).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('get-platform');
  });

  it('routes clipboard.writeText through ipcRenderer.invoke', async () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    await expect(api.clipboard.writeText('hello')).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('clipboard-write-text', 'hello');
  });

  it('routes localFile methods through ipcRenderer.invoke', async () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    await expect(api.localFile.selectApplication()).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('local-file-select-application');
    await expect(api.localFile.clearApplication()).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('local-file-clear-application');
    await expect(api.localFile.open({ sessionId: 's1' })).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('local-file-open', { sessionId: 's1' });
    await expect(api.localFile.close('s1')).resolves.toBe('invoked');
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('local-file-close', 's1');
  });

  it('routes persistentStorage methods through ipcRenderer.sendSync', () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    expect(api.persistentStorage.getItem('theme')).toBe('synced');
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('persistent-storage-get', 'theme');
    api.persistentStorage.setItem('theme', 'dark');
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('persistent-storage-set', {
      key: 'theme',
      value: 'dark',
    });
    api.persistentStorage.removeItem('theme');
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith('persistent-storage-remove', 'theme');
  });

  it('forwards persistent-storage-changed into a window storage event', () => {
    const { ipcRenderer, dispatchedEvents } = loadPreloadWithMocks();
    ipcRenderer.emit('persistent-storage-changed', { sender: {} }, { key: 'theme', oldValue: null, newValue: 'dark' });
    expect(dispatchedEvents).toEqual([
      { type: 'storage', key: 'theme', oldValue: null, newValue: 'dark' },
    ]);
  });

  it('forwards local-file-changed only to registered onChanged listeners', () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    const listener = vi.fn();
    api.localFile.onChanged(listener);
    ipcRenderer.emit('local-file-changed', { sender: {} }, { sessionId: 's1', content: 'new content' });
    expect(listener).toHaveBeenCalledWith({ sessionId: 's1', content: 'new content' });
  });

  it('stops forwarding local-file-changed after offChanged', () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    const listener = vi.fn();
    api.localFile.onChanged(listener);
    api.localFile.offChanged(listener);
    ipcRenderer.emit('local-file-changed', { sender: {} }, { sessionId: 's1', content: 'x' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('forwards local-file-error only with valid session payloads', () => {
    const { api, ipcRenderer } = loadPreloadWithMocks();
    const listener = vi.fn();
    api.localFile.onError(listener);
    ipcRenderer.emit('local-file-error', { sender: {} }, { sessionId: 's1', message: 'boom' });
    expect(listener).toHaveBeenCalledWith({ sessionId: 's1', message: 'boom' });
    ipcRenderer.emit('local-file-error', { sender: {} }, { message: 'no session' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
