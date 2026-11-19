import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { storageGet } from '../utils/storageKeys';
import { encodeLiveSetting, liveSettingKey } from '../../shared/runtime/liveSettings.js';

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
      removeEventListener: vi.fn((type: string, handler: EventListener) => {
        if (type === 'storage') storageListeners = storageListeners.filter(listener => listener !== handler);
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
          migrate: vi.fn((entries: Record<string, string>) => {
            for (const [key, value] of Object.entries(entries)) {
              if (!electronStore.has(key)) electronStore.set(key, value);
            }
            return true;
          }),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function readStored(key: string) { return storageGet(key.slice('opencode.'.length)) ?? undefined; }

  function peerEvent(change: { key: string; newValue: string | null }): StorageEvent {
    const key = liveSettingKey(change.key.slice('opencode.'.length));
    const newValue = encodeLiveSetting(change.newValue);
    electronStore.set(key, newValue);
    return new StorageEvent('storage', { key, newValue });
  }

  async function importFresh() {
    const mod = await import('./useCredentials');
    return mod.useCredentials();
  }

  it('applies a live event and ignores a stale event after credential removal', async () => {
    const credentials = await importFresh();
    const payload = JSON.stringify({ url: 'http://peer.test', username: 'fixture-user', password: 'fixture-only' });
    const key = liveSettingKey('auth.credentials.v1');
    electronStore.set(key, encodeLiveSetting(payload));
    for (const listener of storageListeners) listener(new StorageEvent('storage', { key, newValue: encodeLiveSetting(payload) }));
    expect(credentials.username.value === 'fixture-user').toBe(true);
    expect(credentials.password.value.length > 0).toBe(true);
    electronStore.set(key, encodeLiveSetting(null));
    electronStore.set('opencode.auth.credentials.v1', payload);
    for (const listener of storageListeners) listener(new StorageEvent('storage', { key: 'opencode.auth.credentials.v1', newValue: payload }));
    expect(credentials.username.value).toBe('');
    expect(credentials.password.value).toBe('');
  });

  it('keeps live clear effective after reload with a populated legacy alias', async () => {
    const credentials = await importFresh();
    credentials.save('http://fixture.test', 'fixture-user', 'fixture-only');
    const alias = JSON.stringify({ url: 'http://fixture.test', username: 'fixture-old', password: 'fixture-old-only' });
    electronStore.set('opencode.credentials.v1', alias);
    credentials.clear();
    vi.resetModules();
    const restored = await importFresh();
    restored.load();
    expect(restored.username.value).toBe('');
    expect(restored.password.value).toBe('');
    expect(electronStore.get('opencode.credentials.v1') === alias).toBe(true);
  });

  it('preserves the legacy alias on migration failure', async () => {
    const alias = JSON.stringify({ url: 'http://fixture.test', username: 'fixture-user', password: 'fixture-only' });
    electronStore.set('opencode.credentials.v1', alias);
    const api = window.electronAPI?.persistentStorage;
    if (!api) throw new Error('Missing native storage fixture');
    vi.mocked(api.setItem).mockReturnValue(false);
    const { migrateLegacyCredentials } = await import('./credentialStorage');
    expect(migrateLegacyCredentials()).toBeNull();
    expect(electronStore.get('opencode.credentials.v1') === alias).toBe(true);
  });

  it('preserves the alias when credential migration fails after saving the URL', async () => {
    const alias = JSON.stringify({ url: 'http://fixture.test', username: 'fixture-user', password: 'fixture-only' });
    electronStore.set('opencode.credentials.v1', alias);
    const api = window.electronAPI?.persistentStorage;
    if (!api) throw new Error('Missing native storage fixture');
    vi.mocked(api.setItem).mockImplementation((key, value) => {
      if (key === liveSettingKey('auth.credentials.v1')) return false;
      electronStore.set(key, value);
      return true;
    });
    const { migrateLegacyCredentials } = await import('./credentialStorage');
    expect(migrateLegacyCredentials()).toBeNull();
    expect(electronStore.has(liveSettingKey('auth.serverUrl.v1'))).toBe(true);
    expect(electronStore.has(liveSettingKey('credentials.v1'))).toBe(false);
    expect(electronStore.get('opencode.credentials.v1') === alias).toBe(true);
  });

  it('ignores a corrupt live event without clearing active credentials', async () => {
    const credentials = await importFresh();
    credentials.save('http://fixture.test', 'fixture-user', 'fixture-only');
    const key = liveSettingKey('auth.credentials.v1');
    electronStore.set(key, '{');
    for (const listener of storageListeners) listener(new StorageEvent('storage', { key, newValue: '{' }));
    expect(credentials.username.value === 'fixture-user').toBe(true);
    expect(credentials.password.value.length > 0).toBe(true);
  });

  it('removes scoped credential listeners after one instance is disposed before scope shutdown', async () => {
    const { useCredentials } = await import('./useCredentials');
    const scope = effectScope();
    const credentials = scope.run(() => { const first = useCredentials(); useCredentials(); return first; });
    if (!credentials) throw new Error('credential scope missing');
    expect(storageListeners).toHaveLength(2);
    credentials.dispose();
    expect(storageListeners).toHaveLength(1);
    scope.stop();
    expect(storageListeners).toHaveLength(0);
  });

  it('keeps disposal safe without a browser window, including later scope shutdown', async () => {
    vi.stubGlobal('window', undefined);
    const { useCredentials } = await import('./useCredentials');
    const scope = effectScope();
    const credentials = scope.run(useCredentials);
    if (!credentials) throw new Error('credential scope missing');
    credentials.dispose(); credentials.dispose(); scope.stop();
    expect(storageListeners).toHaveLength(0);
  });

  it('disposes a listener outside Vue scope without updating shared credentials later', async () => {
    const credentials = await importFresh();
    credentials.saveCodex('ws://selected.test/codex', 'private-candidate');
    credentials.dispose(); credentials.dispose();
    for (const listener of storageListeners) listener(peerEvent({ key: 'opencode.auth.codexBridgeUrl.v1', newValue: 'ws://unrelated.test/codex' }));
    expect(storageListeners).toHaveLength(0);
    expect(credentials.codexBridgeUrl.value).toBe('ws://selected.test/codex');
  });

  it('never offers native OpenCode auth as management auth and selects only the active bridge', async () => {
    const credentials = await importFresh();
    const { getRuntimeConnectionCandidate } = await import('./useCredentials');
    credentials.save('http://native.test', 'native-user', 'native-private');
    expect(getRuntimeConnectionCandidate()).toBeNull();
    credentials.saveCodex('ws://selected.test/codex', 'private-candidate');
    const candidate = getRuntimeConnectionCandidate();
    expect(candidate?.reference).toEqual({ url: 'ws://selected.test/runtime' });
    expect(JSON.stringify(candidate)).not.toContain('private-candidate');
    expect(await candidate?.resolveAuthentication()).toEqual({ bridgeToken: 'private-candidate' });
    credentials.saveDsh('ws://dsh.test/dsh/ws', 'dsh-private'); credentials.clear();
    expect(getRuntimeConnectionCandidate()).toBeNull();
    expect(readStored('opencode.auth.codexBridgeToken.v1')).toBe('private-candidate');
    credentials.dispose();
  });

  it('persists baseUrl and auth data to Electron storage', async () => {
    const credentials = await importFresh();

    credentials.save('http://localhost:4312/', 'alice', 'secret');

    expect(readStored('opencode.auth.credentials.v1')).toContain('http://localhost:4312/');
    expect(readStored('opencode.auth.serverUrl.v1')).toBe('http://localhost:4312/');
    expect(electronStore.has('opencode.auth.credentials.v1')).toBe(false);
    expect(electronStore.has('opencode.auth.serverUrl.v1')).toBe(false);
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
    expect(readStored('opencode.auth.credentials.v1')).toBeUndefined();
    expect(readStored('opencode.auth.serverUrl.v1')).toBe('http://localhost:5555');
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
    expect(readStored('opencode.auth.serverUrl.v1')).toBe('http://localhost:4096');
    expect(readStored('opencode.auth.credentials.v1')).toContain('legacy-user');
    expect(readStored('opencode.credentials.v1')).toBeUndefined();
    expect(electronStore.has('opencode.credentials.v1')).toBe(true);
  });

  it('reacts to legacy cross-window storage updates without a live overlay', async () => {
    const credentials = await importFresh();

    const payload = JSON.stringify({
      url: 'http://localhost:9000',
      username: 'bob',
      password: 'pw',
    });

    electronStore.set('opencode.auth.credentials.v1', payload);
    for (const listener of storageListeners) {
      listener(new StorageEvent('storage', {
        key: 'opencode.auth.credentials.v1',
        newValue: payload,
      }));
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
    expect(readStored('opencode.auth.acpAgentId.v1')).toBe('oh-my-pi');
    expect(readStored('opencode.auth.acpBridgeUrl.v1')).toBe('ws://localhost:23004');
    expect(readStored('opencode.auth.acpBridgeToken.v1')).toBe('bridge-secret');

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
    expect(readStored('opencode.auth.acpBridgeUrl.v1')).toBe('ws://bridge.test:23004');
    expect(credentials.acpBridgeToken.value).toBe('legacy-secret');
    expect(readStored('opencode.auth.acpBridgeToken.v1')).toBe('legacy-secret');
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

  it('persists and restores kimi-web bridge credentials', async () => {
    const first = await importFresh();
    first.saveKimiWeb('ws://localhost:23004/kimi-web/ws', 'kimi-bridge-secret');

    expect(first.backendKind.value).toBe('kimi-web');
    expect(first.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');
    expect(first.kimiWebBridgeToken.value).toBe('kimi-bridge-secret');
    expect(first.isConfigured.value).toBe(true);
    expect(readStored('opencode.auth.backendKind.v1')).toBe('kimi-web');
    expect(readStored('opencode.auth.kimiWebBridgeUrl.v1')).toBe(
      'ws://localhost:23004/kimi-web/ws',
    );
    expect(readStored('opencode.auth.kimiWebBridgeToken.v1')).toBe('kimi-bridge-secret');

    vi.resetModules();
    const second = await importFresh();
    second.load();

    expect(second.backendKind.value).toBe('kimi-web');
    expect(second.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');
    expect(second.kimiWebBridgeToken.value).toBe('kimi-bridge-secret');
    expect(second.isConfigured.value).toBe(true);
  });

  it('trims the kimi-web bridge URL and drops a blank bridge token from storage', async () => {
    const credentials = await importFresh();

    credentials.saveKimiWeb('  ws://localhost:23004/kimi-web/ws  ', '   ');

    expect(credentials.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');
    expect(readStored('opencode.auth.kimiWebBridgeToken.v1')).toBeUndefined();

    credentials.saveKimiWeb('ws://localhost:23004/kimi-web/ws', '');
    expect(credentials.kimiWebBridgeToken.value).toBe('');
    expect(readStored('opencode.auth.kimiWebBridgeToken.v1')).toBeUndefined();
  });

  it('rejects an empty kimi-web bridge URL before activating the backend', async () => {
    const credentials = await importFresh();

    expect(() => credentials.saveKimiWeb('   ', 'token')).toThrow(
      'Kimi Web bridge URL is required.',
    );
    expect(credentials.backendKind.value).toBe('opencode');
    expect(readStored('opencode.auth.backendKind.v1')).toBeUndefined();
    expect(readStored('opencode.auth.kimiWebBridgeUrl.v1')).toBeUndefined();
  });

  it('clears the kimi-web bridge token but keeps the persisted URL', async () => {
    const credentials = await importFresh();

    credentials.saveKimiWeb('ws://localhost:23004/kimi-web/ws', 'secret');
    credentials.clear();

    expect(credentials.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');
    expect(credentials.kimiWebBridgeToken.value).toBe('');
    expect(credentials.isConfigured.value).toBe(true);
    expect(readStored('opencode.auth.kimiWebBridgeToken.v1')).toBeUndefined();
    expect(readStored('opencode.auth.kimiWebBridgeUrl.v1')).toBe(
      'ws://localhost:23004/kimi-web/ws',
    );
  });

  it('reacts to cross-window kimi-web credential updates and ignores unrelated keys', async () => {
    const credentials = await importFresh();
    credentials.saveKimiWeb('ws://localhost:23004/kimi-web/ws', 'old-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.codexBridgeToken.v1',
        newValue: 'codex-secret',
      }));
    }
    expect(credentials.kimiWebBridgeToken.value).toBe('old-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.kimiWebBridgeToken.v1',
        newValue: 'new-secret',
      }));
    }
    expect(credentials.kimiWebBridgeToken.value).toBe('new-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.kimiWebBridgeUrl.v1',
        newValue: 'ws://bridge.test:23004/kimi-web/ws',
      }));
    }
    expect(credentials.kimiWebBridgeUrl.value).toBe('ws://bridge.test:23004/kimi-web/ws');

    for (const listener of storageListeners) {
      listener(peerEvent({ key: 'opencode.auth.backendKind.v1', newValue: 'kimi-web' }));
    }
    expect(credentials.backendKind.value).toBe('kimi-web');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.kimiWebBridgeUrl.v1',
        newValue: null,
      }));
    }
    expect(credentials.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.kimiWebBridgeToken.v1',
        newValue: null,
      }));
    }
    expect(credentials.kimiWebBridgeToken.value).toBe('');
  });

  it('persists and restores dsh bridge credentials', async () => {
    const first = await importFresh();
    first.saveDsh('ws://bridge.test:23004/dsh/ws', 'dsh-bridge-secret');

    expect(first.backendKind.value).toBe('dsh');
    expect(first.dshBridgeUrl.value).toBe('ws://bridge.test:23004/dsh/ws');
    expect(first.dshBridgeToken.value).toBe('dsh-bridge-secret');
    expect(first.isConfigured.value).toBe(true);
    expect(readStored('opencode.auth.backendKind.v1')).toBe('dsh');
    expect(readStored('opencode.auth.dshBridgeUrl.v1')).toBe(
      'ws://bridge.test:23004/dsh/ws',
    );
    expect(readStored('opencode.auth.dshBridgeToken.v1')).toBe('dsh-bridge-secret');

    vi.resetModules();
    const second = await importFresh();
    second.load();

    expect(second.backendKind.value).toBe('dsh');
    expect(second.dshBridgeUrl.value).toBe('ws://bridge.test:23004/dsh/ws');
    expect(second.dshBridgeToken.value).toBe('dsh-bridge-secret');
    expect(second.isConfigured.value).toBe(true);
  });

  it('trims the dsh bridge URL and drops a blank bridge token from storage', async () => {
    const credentials = await importFresh();

    credentials.saveDsh('  ws://localhost:23004/dsh/ws  ', '   ');

    expect(credentials.dshBridgeUrl.value).toBe('ws://localhost:23004/dsh/ws');
    expect(readStored('opencode.auth.dshBridgeToken.v1')).toBeUndefined();
  });

  it('rejects an empty dsh bridge URL before activating the backend', async () => {
    const credentials = await importFresh();

    expect(() => credentials.saveDsh('   ', 'token')).toThrow('dsh bridge URL is required.');
    expect(credentials.backendKind.value).toBe('opencode');
    expect(readStored('opencode.auth.backendKind.v1')).toBeUndefined();
    expect(readStored('opencode.auth.dshBridgeUrl.v1')).toBeUndefined();
  });

  it('clears the dsh bridge token but keeps the persisted URL', async () => {
    const credentials = await importFresh();

    credentials.saveDsh('ws://bridge.test:23004/dsh/ws', 'secret');
    expect(credentials.isConfigured.value).toBe(true);
    credentials.clear();

    expect(credentials.dshBridgeUrl.value).toBe('ws://bridge.test:23004/dsh/ws');
    expect(credentials.dshBridgeToken.value).toBe('');
    expect(credentials.isConfigured.value).toBe(false);
    vi.resetModules();
    const restored = await importFresh();
    restored.load();
    expect(restored.isConfigured.value).toBe(false);
    expect(readStored('opencode.auth.dshBridgeToken.v1')).toBeUndefined();
    expect(readStored('opencode.auth.dshBridgeUrl.v1')).toBe(
      'ws://bridge.test:23004/dsh/ws',
    );
  });

  it('restores a saved local DSH connection without an optional bridge token', async () => {
    const credentials = await importFresh();

    credentials.saveDsh('ws://localhost:23004/dsh/ws', '');
    expect(credentials.isConfigured.value).toBe(true);
    vi.resetModules();
    const restored = await importFresh();
    restored.load();
    expect(restored.backendKind.value).toBe('dsh');
    expect(restored.isConfigured.value).toBe(true);

    credentials.saveDsh('ws://localhost:23004/dsh/ws', 'token');
    expect(credentials.isConfigured.value).toBe(true);
  });

  it('restores the dsh backend kind and credentials from storage', async () => {
    electronStore.set('opencode.auth.backendKind.v1', 'dsh');
    electronStore.set('opencode.auth.dshBridgeUrl.v1', 'ws://bridge.test:23004/dsh/ws');
    electronStore.set('opencode.auth.dshBridgeToken.v1', 'stored-secret');

    const credentials = await importFresh();
    credentials.load();

    expect(credentials.backendKind.value).toBe('dsh');
    expect(credentials.dshBridgeUrl.value).toBe('ws://bridge.test:23004/dsh/ws');
    expect(credentials.dshBridgeToken.value).toBe('stored-secret');
    expect(credentials.isConfigured.value).toBe(true);
  });

  it('reacts to cross-window dsh credential updates and ignores unrelated keys', async () => {
    const credentials = await importFresh();
    credentials.saveDsh('ws://bridge.test:23004/dsh/ws', 'old-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.kimiWebBridgeToken.v1',
        newValue: 'kimi-secret',
      }));
    }
    expect(credentials.dshBridgeToken.value).toBe('old-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.dshBridgeToken.v1',
        newValue: 'new-secret',
      }));
    }
    expect(credentials.dshBridgeToken.value).toBe('new-secret');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.dshBridgeUrl.v1',
        newValue: 'ws://other.test:23004/dsh/ws',
      }));
    }
    expect(credentials.dshBridgeUrl.value).toBe('ws://other.test:23004/dsh/ws');

    for (const listener of storageListeners) {
      listener(peerEvent({ key: 'opencode.auth.backendKind.v1', newValue: 'dsh' }));
    }
    expect(credentials.backendKind.value).toBe('dsh');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.dshBridgeUrl.v1',
        newValue: null,
      }));
    }
    expect(credentials.dshBridgeUrl.value).toBe('ws://localhost:23004/dsh/ws');

    for (const listener of storageListeners) {
      listener(peerEvent({
        key: 'opencode.auth.dshBridgeToken.v1',
        newValue: null,
      }));
    }
    expect(credentials.dshBridgeToken.value).toBe('');
  });

  it('writes the dsh token only inside the auth namespace', async () => {
    const credentials = await importFresh();
    const before = new Set(electronStore.keys());

    credentials.saveDsh('ws://localhost:23004/dsh/ws', 'namespace-secret');

    const written = [...electronStore.keys()].filter((key) => !before.has(key));
    expect(written.sort()).toEqual([
      'vis.live-settings.v1.auth.backendKind.v1',
      'vis.live-settings.v1.auth.dshAutoConnect.v1',
      'vis.live-settings.v1.auth.dshBridgeToken.v1',
      'vis.live-settings.v1.auth.dshBridgeUrl.v1',
    ]);
    expect(written.every((key) => key.startsWith('vis.live-settings.v1.auth.'))).toBe(true);
    expect(localStore.size).toBe(0);
  });
});
