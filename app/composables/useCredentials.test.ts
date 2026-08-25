import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('useCredentials', () => {
  let storageListeners: Array<(event: StorageEvent) => void>;
  let localStore: Map<string, string>;
  let electronStore: Map<string, string>;

  beforeEach(() => {
    vi.resetModules();
    storageListeners = [];
    localStore = new Map();
    electronStore = new Map();

    const localStorage = {
      getItem: vi.fn((key: string) => localStore.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStore.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        localStore.delete(key);
      }),
      clear: vi.fn(() => {
        localStore.clear();
      }),
      key: vi.fn((index: number) => Array.from(localStore.keys())[index] ?? null),
      get length() {
        return localStore.size;
      },
    } as Storage;

    vi.stubGlobal('window', {
      localStorage,
      addEventListener: vi.fn((type: string, handler: EventListener) => {
        if (type === 'storage') {
          storageListeners.push(handler as (event: StorageEvent) => void);
        }
      }),
      electronAPI: {
        persistentStorage: {
          getItem: vi.fn((key: string) => electronStore.get(key) ?? null),
          setItem: vi.fn((key: string, value: string) => {
            electronStore.set(key, value);
          }),
          removeItem: vi.fn((key: string) => {
            electronStore.delete(key);
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function importFresh() {
    const mod = await import('./useCredentials');
    return mod.useCredentials();
  }

  it('persists baseUrl and auth data to Electron storage', async () => {
    const credentials = await importFresh();

    credentials.save('http://localhost:4312/', 'alice', 'secret');

    expect(electronStore.get('opencode.auth.credentials.v1')).toContain('http://localhost:4312/');
    expect(electronStore.get('opencode.auth.serverUrl.v1')).toBe('http://localhost:4312/');
    expect(credentials.baseUrl.value).toBe('http://localhost:4312');
    expect(localStore.size).toBe(0);
  });

  it('restores persisted server URL after a fresh module load', async () => {
    const first = await importFresh();
    first.save('http://127.0.0.1:7777', '', '');

    vi.resetModules();

    const second = await importFresh();
    second.load();

    expect(second.url.value).toBe('http://127.0.0.1:7777');
    expect(second.baseUrl.value).toBe('http://127.0.0.1:7777');
    expect(second.isConfigured.value).toBe(true);
  });

  it('keeps the server URL when clearing auth', async () => {
    const credentials = await importFresh();

    credentials.save('http://localhost:5555', 'alice', 'secret');
    credentials.clear();

    expect(credentials.url.value).toBe('http://localhost:5555');
    expect(credentials.username.value).toBe('');
    expect(credentials.password.value).toBe('');
    expect(electronStore.get('opencode.auth.credentials.v1')).toBeUndefined();
    expect(electronStore.get('opencode.auth.serverUrl.v1')).toBe('http://localhost:5555');
  });

  it('migrates legacy credentials storage into the new keys', async () => {
    electronStore.set(
      'opencode.credentials.v1',
      JSON.stringify({
        url: 'http://localhost:4096',
        username: 'legacy-user',
        password: 'legacy-pass',
      }),
    );

    const credentials = await importFresh();
    credentials.load();

    expect(credentials.url.value).toBe('http://localhost:4096');
    expect(credentials.username.value).toBe('legacy-user');
    expect(credentials.password.value).toBe('legacy-pass');
    expect(electronStore.get('opencode.auth.serverUrl.v1')).toBe('http://localhost:4096');
    expect(electronStore.get('opencode.auth.credentials.v1')).toContain('legacy-user');
    expect(electronStore.get('opencode.credentials.v1')).toBeUndefined();
  });

  it('reacts to cross-window storage updates', async () => {
    const credentials = await importFresh();

    const payload = JSON.stringify({
      url: 'http://localhost:9000',
      username: 'bob',
      password: 'pw',
    });

    for (const listener of storageListeners) {
      listener({
        key: 'opencode.auth.credentials.v1',
        newValue: payload,
      } as StorageEvent);
    }

    expect(credentials.url.value).toBe('http://localhost:9000');
    expect(credentials.username.value).toBe('bob');
    expect(credentials.password.value).toBe('pw');
  });

  it('persists and restores ACP bridge credentials and agent selection', async () => {
    const first = await importFresh();
    first.saveAcp('ws://localhost:23004', 'bridge-secret', 'oh-my-pi');

    expect(first.backendKind.value).toBe('acp');
    expect(first.acpAgentId.value).toBe('oh-my-pi');
    expect(first.acpBridgeUrl.value).toBe('ws://localhost:23004');
    expect(first.acpBridgeToken.value).toBe('bridge-secret');
    expect(first.codexBridgeUrl.value).toBe('ws://localhost:23004/codex');
    expect(first.codexBridgeToken.value).toBe('');
    expect(first.isConfigured.value).toBe(true);
    expect(electronStore.get('opencode.auth.acpAgentId.v1')).toBe('oh-my-pi');
    expect(electronStore.get('opencode.auth.acpBridgeUrl.v1')).toBe('ws://localhost:23004');
    expect(electronStore.get('opencode.auth.acpBridgeToken.v1')).toBe('bridge-secret');

    vi.resetModules();
    const second = await importFresh();
    second.load();

    expect(second.backendKind.value).toBe('acp');
    expect(second.codexBridgeUrl.value).toBe('ws://localhost:23004/codex');
    expect(second.acpBridgeUrl.value).toBe('ws://localhost:23004');
    expect(second.acpBridgeToken.value).toBe('bridge-secret');
    expect(second.codexBridgeToken.value).toBe('');
    expect(second.acpAgentId.value).toBe('oh-my-pi');
  });

  it('rejects an empty ACP agent id before activating the ACP backend', async () => {
    const credentials = await importFresh();

    expect(() => credentials.saveAcp('ws://localhost:23004', '', '   ')).toThrow(
      'ACP agent ID is required.',
    );
    expect(credentials.backendKind.value).toBe('opencode');
  });

  it('migrates the legacy shared Codex URL to an ACP base URL', async () => {
    electronStore.set('opencode.auth.backendKind.v1', 'acp');
    electronStore.set('opencode.auth.codexBridgeUrl.v1', 'ws://bridge.test:23004/codex');
    electronStore.set('opencode.auth.codexBridgeToken.v1', 'legacy-secret');
    electronStore.set('opencode.auth.acpAgentId.v1', 'oh-my-pi');
    const credentials = await importFresh();

    credentials.load();

    expect(credentials.acpBridgeUrl.value).toBe('ws://bridge.test:23004');
    expect(electronStore.get('opencode.auth.acpBridgeUrl.v1')).toBe('ws://bridge.test:23004');
    expect(credentials.acpBridgeToken.value).toBe('legacy-secret');
    expect(electronStore.get('opencode.auth.acpBridgeToken.v1')).toBe('legacy-secret');
  });

  it('falls back to OpenCode when persisted ACP credentials have no agent id', async () => {
    electronStore.set('opencode.auth.backendKind.v1', 'acp');
    electronStore.set('opencode.auth.codexBridgeUrl.v1', 'ws://localhost:23004/codex');
    electronStore.set('opencode.auth.acpAgentId.v1', '  ');
    const credentials = await importFresh();

    credentials.load();

    expect(credentials.backendKind.value).toBe('opencode');
    expect(credentials.isConfigured.value).toBe(false);
  });
});
