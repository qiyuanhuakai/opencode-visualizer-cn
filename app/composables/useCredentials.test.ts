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
            return true;
          }),
          removeItem: vi.fn((key: string) => {
            electronStore.delete(key);
            return true;
          }),
          migrate: vi.fn((entries: Record<string, string>) => {
            for (const [key, value] of Object.entries(entries)) {
              if (!electronStore.has(key)) electronStore.set(key, value);
            }
            return true;
          }),
          update: vi.fn((entries: Record<string, string | null>) => {
            for (const [key, value] of Object.entries(entries)) {
              if (value === null) electronStore.delete(key);
              else electronStore.set(key, value);
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
    await second.load();

    expect(second.url.value).toBe('http://127.0.0.1:7777');
    expect(second.baseUrl.value).toBe('http://127.0.0.1:7777');
    expect(second.isConfigured.value).toBe(true);
  });

  it('waits for the credential transaction before publishing the initial load', async () => {
    // Given: another window holds the mutation lock after committing credentials C.
    const { runCredentialMutationExclusive } = await import('../utils/credentialCleanup');
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runCredentialMutationExclusive(async () => {
      electronStore.set('opencode.auth.serverUrl.v1', 'http://c');
      electronStore.set(
        'opencode.auth.credentials.v1',
        JSON.stringify({ url: 'http://c', username: 'carol', password: 'secret-c' }),
      );
      electronStore.set('opencode.auth.credentialRevision.v1', 'revision-c');
      markMutationStarted();
      await mutationGate;
    });
    await mutationStarted;
    const credentials = await importFresh();

    // When: initial load starts while C's transaction still owns the lock.
    const loading = credentials.load();
    await Promise.resolve();

    // Then: no credential state is published until load acquires the lock.
    expect(credentials.url.value).toBe('');
    releaseMutation();
    await mutation;
    await loading;
    expect(credentials.url.value).toBe('http://c');
    expect(credentials.username.value).toBe('carol');
    expect(credentials.credentialRevision.value).toBe('revision-c');
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

  it('clears canonical and legacy credential aliases together', async () => {
    // Given: canonical credentials coexist with residue from the legacy storage key.
    electronStore.set(
      'opencode.auth.credentials.v1',
      JSON.stringify({ url: 'http://localhost:5555', username: 'alice', password: 'secret' }),
    );
    electronStore.set(
      'opencode.credentials.v1',
      JSON.stringify({ url: 'http://localhost:4096', username: 'legacy', password: 'stale' }),
    );
    const credentials = await importFresh();
    await credentials.load();

    // When: the user clears authentication.
    credentials.clear();

    // Then: neither key can restore credentials on a later launch.
    expect(electronStore.get('opencode.auth.credentials.v1')).toBeUndefined();
    expect(electronStore.get('opencode.credentials.v1')).toBeUndefined();
  });

  it('keeps the active credentials when the deletion transaction is rejected', async () => {
    // Given: both aliases exist and native storage rejects their atomic deletion.
    const canonical = JSON.stringify({
      url: 'http://localhost:5555',
      username: 'alice',
      password: 'secret',
    });
    electronStore.set('opencode.auth.credentials.v1', canonical);
    electronStore.set('opencode.credentials.v1', canonical);
    const update = vi.mocked(window.electronAPI!.persistentStorage!.update);
    update.mockReturnValue(false);
    const credentials = await importFresh();
    await credentials.load();

    // When: the user tries to clear authentication during the storage failure.
    const cleared = credentials.clear();

    // Then: logout remains unsuccessful and neither durable nor in-memory auth is lost.
    expect(cleared).toBe(false);
    expect(credentials.username.value).toBe('alice');
    expect(credentials.password.value).toBe('secret');
    expect(electronStore.get('opencode.auth.credentials.v1')).toBe(canonical);
    expect(electronStore.get('opencode.credentials.v1')).toBe(canonical);
  });

  it('rejects replacement credentials without mutating memory when persistence is unavailable', async () => {
    // Given: Electron migration completed but every credential mutation is rejected.
    const persistentStorage = window.electronAPI!.persistentStorage!;
    vi.mocked(persistentStorage.update).mockReturnValue(false);
    vi.mocked(persistentStorage.setItem).mockReturnValue(false);
    vi.mocked(persistentStorage.removeItem).mockReturnValue(false);
    const credentials = await importFresh();
    const initial = {
      backendKind: credentials.backendKind.value,
      codexUrl: credentials.codexBridgeUrl.value,
      acpUrl: credentials.acpBridgeUrl.value,
    };

    // When: each login mode attempts to replace its credentials.
    const openCodeSaved = credentials.save('http://replacement', 'new-user', 'new-password');
    const codexSaved = credentials.saveCodex('ws://replacement-codex', 'new-codex-token');
    const acpSaved = credentials.saveAcp(
      'ws://replacement-acp',
      'new-acp-token',
      'replacement-agent',
    );

    // Then: every caller receives failure and no replacement is exposed in memory.
    expect([openCodeSaved, codexSaved, acpSaved]).toEqual([false, false, false]);
    expect(credentials.backendKind.value).toBe(initial.backendKind);
    expect(credentials.url.value).toBe('');
    expect(credentials.username.value).toBe('');
    expect(credentials.password.value).toBe('');
    expect(credentials.codexBridgeUrl.value).toBe(initial.codexUrl);
    expect(credentials.codexBridgeToken.value).toBe('');
    expect(credentials.acpBridgeUrl.value).toBe(initial.acpUrl);
    expect(credentials.acpBridgeToken.value).toBe('');
    expect(credentials.acpAgentId.value).toBe('');
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
    await credentials.load();

    expect(credentials.url.value).toBe('http://localhost:4096');
    expect(credentials.username.value).toBe('legacy-user');
    expect(credentials.password.value).toBe('legacy-pass');
    expect(electronStore.get('opencode.auth.serverUrl.v1')).toBe('http://localhost:4096');
    expect(electronStore.get('opencode.auth.credentials.v1')).toContain('legacy-user');
    expect(electronStore.get('opencode.credentials.v1')).toBeUndefined();
  });

  it('retains legacy credentials when their atomic migration is rejected', async () => {
    // Given: legacy credentials are the only durable copy and native storage rejects migration.
    const legacy = JSON.stringify({
      url: 'http://localhost:4096',
      username: 'legacy-user',
      password: 'legacy-pass',
    });
    electronStore.set('opencode.credentials.v1', legacy);
    const persistentStorage = window.electronAPI!.persistentStorage!;
    vi.mocked(persistentStorage.update).mockReturnValueOnce(false);

    // When: credentials load during the failed migration.
    const credentials = await importFresh();
    await credentials.load();

    // Then: the source remains retryable and unacknowledged secrets are not exposed as canonical.
    expect(electronStore.get('opencode.credentials.v1')).toBe(legacy);
    expect(electronStore.get('opencode.auth.credentials.v1')).toBeUndefined();
    expect(credentials.username.value).toBe('');
    expect(credentials.password.value).toBe('');
  });

  it('removes the legacy alias in the same replacement credential transaction', async () => {
    // Given: stale legacy credentials remain beside a new login attempt.
    electronStore.set(
      'opencode.credentials.v1',
      JSON.stringify({ url: 'http://old', username: 'old-user', password: 'old-secret' }),
    );
    const credentials = await importFresh();

    // When: replacement OpenCode credentials are persisted.
    expect(credentials.save('http://new', 'new-user', 'new-secret')).toBe(true);

    // Then: the atomic bundle cannot leave the stale alias available for later resurrection.
    expect(electronStore.get('opencode.credentials.v1')).toBeUndefined();
    expect(electronStore.get('opencode.auth.credentials.v1')).toContain('new-user');
  });

  it('reacts to cross-window storage updates', async () => {
    const credentials = await importFresh();

    const payload = JSON.stringify({
      url: 'http://localhost:9000',
      username: 'bob',
      password: 'pw',
    });
    electronStore.set('opencode.auth.serverUrl.v1', 'http://localhost:9000');
    electronStore.set('opencode.auth.credentials.v1', payload);

    for (const listener of storageListeners) {
      listener({
        key: 'opencode.auth.credentials.v1',
        newValue: payload,
      } as StorageEvent);
    }

    await vi.waitFor(() => expect(credentials.url.value).toBe('http://localhost:9000'));
    expect(credentials.username.value).toBe('bob');
    expect(credentials.password.value).toBe('pw');
  });

  it('applies a committed cross-window credential snapshot before its revision', async () => {
    // Given: window A is using credentials A and window B atomically commits credentials B.
    const credentials = await importFresh();
    expect(credentials.save('http://a', 'alice', 'secret-a')).toBe(true);
    const replacement = JSON.stringify({
      url: 'http://b',
      username: 'bob',
      password: 'secret-b',
    });
    electronStore.set('opencode.auth.serverUrl.v1', 'http://b');
    electronStore.set('opencode.auth.credentials.v1', replacement);
    electronStore.set('opencode.auth.credentialRevision.v1', 'revision-b');

    // When: the revision event is delivered before the later per-key event tasks.
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.auth.credentialRevision.v1',
        newValue: 'revision-b',
      } as StorageEvent);
    }

    // Then: observers can only see the complete B snapshot paired with revision B.
    await vi.waitFor(() => expect(credentials.url.value).toBe('http://b'));
    expect(credentials.username.value).toBe('bob');
    expect(credentials.password.value).toBe('secret-b');
    expect(credentials.credentialRevision.value).toBe('revision-b');
  });

  it('waits for the credential transaction before reading a storage-event snapshot', async () => {
    // Given: credentials A are active while another window holds the mutation lock for C.
    const credentials = await importFresh();
    expect(credentials.save('http://a', 'alice', 'secret-a')).toBe(true);
    const { runCredentialMutationExclusive } = await import('../utils/credentialCleanup');
    let releaseMutation!: () => void;
    let markMutationStarted!: () => void;
    const mutationGate = new Promise<void>((resolve) => {
      releaseMutation = resolve;
    });
    const mutationStarted = new Promise<void>((resolve) => {
      markMutationStarted = resolve;
    });
    const mutation = runCredentialMutationExclusive(async () => {
      electronStore.set('opencode.auth.serverUrl.v1', 'http://c');
      electronStore.set(
        'opencode.auth.credentials.v1',
        JSON.stringify({ url: 'http://c', username: 'carol', password: 'secret-c' }),
      );
      electronStore.set('opencode.auth.credentialRevision.v1', 'revision-c');
      markMutationStarted();
      await mutationGate;
    });
    await mutationStarted;

    // When: an auth storage event arrives before that transaction releases its lock.
    for (const listener of storageListeners) {
      listener({
        key: 'opencode.auth.credentialRevision.v1',
        newValue: 'revision-c',
      } as StorageEvent);
    }
    await Promise.resolve();

    // Then: A remains published until the reader can acquire the same lock and load all of C.
    expect(credentials.url.value).toBe('http://a');
    expect(credentials.username.value).toBe('alice');
    releaseMutation();
    await mutation;
    await vi.waitFor(() => expect(credentials.credentialRevision.value).toBe('revision-c'));
    expect(credentials.url.value).toBe('http://c');
    expect(credentials.username.value).toBe('carol');
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
    await second.load();

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

    await credentials.load();

    expect(credentials.acpBridgeUrl.value).toBe('ws://bridge.test:23004');
    expect(electronStore.get('opencode.auth.acpBridgeUrl.v1')).toBe('ws://bridge.test:23004');
    expect(credentials.acpBridgeToken.value).toBe('legacy-secret');
    expect(electronStore.get('opencode.auth.acpBridgeToken.v1')).toBe('legacy-secret');
  });

  it('does not resurrect a migrated shared token after ACP logout', async () => {
    // Given: an ACP profile imported the historical shared Codex token on its first launch.
    electronStore.set('opencode.auth.backendKind.v1', 'acp');
    electronStore.set('opencode.auth.codexBridgeUrl.v1', 'ws://bridge.test:23004/codex');
    electronStore.set('opencode.auth.codexBridgeToken.v1', 'legacy-secret');
    electronStore.set('opencode.auth.acpAgentId.v1', 'oh-my-pi');
    const first = await importFresh();
    await first.load();
    expect(first.acpBridgeToken.value).toBe('legacy-secret');

    // When: ACP logout succeeds, then tokenless login retains that ACP selection.
    expect(first.clear()).toBe(true);
    expect(first.saveAcp('ws://bridge.test:23004', '', 'oh-my-pi')).toBe(true);
    vi.resetModules();
    const second = await importFresh();
    await second.load();

    // Then: neither the canonical nor historical token can silently authenticate ACP again.
    expect(electronStore.get('opencode.auth.acpBridgeToken.v1')).toBe('');
    expect(electronStore.get('opencode.auth.codexBridgeToken.v1')).toBe('legacy-secret');
    expect(second.acpBridgeToken.value).toBe('');
  });

  it('assigns a new revision to same-value replacement credentials', async () => {
    // Given: one durable credential bundle owns the active connection revision.
    const credentials = await importFresh();
    expect(credentials.save('http://localhost:4096', 'alice', 'secret')).toBe(true);
    const firstRevision = credentials.getRevision();

    // When: the same credential values are explicitly submitted again.
    expect(credentials.save('http://localhost:4096', 'alice', 'secret')).toBe(true);
    const secondRevision = credentials.getRevision();

    // Then: the old owner cannot clear the replacement and logout leaves a new tombstone revision.
    expect(firstRevision).not.toBeNull();
    expect(secondRevision).not.toBe(firstRevision);
    expect(credentials.clearIfRevision(firstRevision)).toBe('stale');
    expect(credentials.password.value).toBe('secret');
    expect(credentials.clearIfRevision(secondRevision)).toBe('cleared');
    const logoutRevision = credentials.getRevision();
    expect(logoutRevision).not.toBeNull();
    expect(logoutRevision).not.toBe(secondRevision);
    expect(credentials.clearIfRevision(secondRevision)).toBe('already-cleared');
  });

  it('falls back to OpenCode when persisted ACP credentials have no agent id', async () => {
    electronStore.set('opencode.auth.backendKind.v1', 'acp');
    electronStore.set('opencode.auth.codexBridgeUrl.v1', 'ws://localhost:23004/codex');
    electronStore.set('opencode.auth.acpAgentId.v1', '  ');
    const credentials = await importFresh();

    await credentials.load();

    expect(credentials.backendKind.value).toBe('opencode');
    expect(credentials.isConfigured.value).toBe(false);
  });
});
