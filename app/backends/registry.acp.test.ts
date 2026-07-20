import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ACP_BRIDGE_URL,
  configureAcpBackend,
  disconnectAcpBackend,
  getActiveBackendKind,
  getBackendAdapter,
  getPersistedAcpBridgeUrl,
  setActiveBackendKind,
} from './registry';
import { StorageKeys, storageGet, storageRemove, storageSet } from '../utils/storageKeys';

describe('ACP backend registry', () => {
  beforeEach(() => {
    storageRemove(StorageKeys.auth.backendKind);
    storageRemove(StorageKeys.auth.acpBridgeUrl);
    storageRemove(StorageKeys.auth.acpBridgeToken);
    storageRemove(StorageKeys.auth.codexBridgeUrl);
    storageRemove(StorageKeys.auth.codexBridgeToken);
    storageRemove(StorageKeys.auth.acpAgentId);
    setActiveBackendKind('opencode');
  });

  it('uses a base bridge URL for ACP independently from Codex', () => {
    expect(getPersistedAcpBridgeUrl()).toBe(DEFAULT_ACP_BRIDGE_URL);
    storageSet(StorageKeys.auth.codexBridgeUrl, 'ws://custom-host:23104/codex');
    expect(getPersistedAcpBridgeUrl()).toBe(DEFAULT_ACP_BRIDGE_URL);
    storageSet(StorageKeys.auth.backendKind, 'acp');
    expect(getPersistedAcpBridgeUrl()).toBe('ws://custom-host:23104');
  });

  it('creates a dynamic ACP adapter from the shared bridge credentials', () => {
    configureAcpBackend({
      bridgeUrl: 'ws://localhost:23004',
      bridgeToken: 'secret',
      agentId: 'oh-my-pi',
    });
    setActiveBackendKind('acp');

    expect(getActiveBackendKind()).toBe('acp');
    expect(getBackendAdapter('acp')).toEqual(expect.objectContaining({ kind: 'acp' }));
    expect(storageGet(StorageKeys.auth.acpAgentId)).toBeNull();
  });

  it('rejects an empty ACP agent id', () => {
    expect(() =>
      configureAcpBackend({
        bridgeUrl: 'ws://localhost:23004',
        agentId: '   ',
      }),
    ).toThrow('ACP agent ID is required');
  });

  it('does not overwrite persisted bridge credentials during runtime configuration', () => {
    storageSet(StorageKeys.auth.codexBridgeUrl, 'ws://custom-host:23104/codex');

    configureAcpBackend({
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'oh-my-pi',
    });

    expect(storageGet(StorageKeys.auth.codexBridgeUrl)).toBe('ws://custom-host:23104/codex');
  });

  it('reuses the ACP adapter when reactive configuration is unchanged', () => {
    const options = {
      bridgeUrl: 'ws://localhost:23004',
      bridgeToken: 'secret',
      agentId: 'oh-my-pi',
    };
    configureAcpBackend(options);
    const first = getBackendAdapter('acp');

    configureAcpBackend(options);

    expect(getBackendAdapter('acp')).toBe(first);
  });

  it('returns the current ACP adapter so event bridges can rebind after configuration changes', () => {
    const first = configureAcpBackend({
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'oh-my-pi',
    });
    const replacement = configureAcpBackend({
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'kimi-code',
    });

    expect(first).toEqual(expect.objectContaining({ kind: 'acp' }));
    expect(replacement).toEqual(expect.objectContaining({ kind: 'acp' }));
    expect(replacement).not.toBe(first);
  });

  it('disconnects the configured ACP adapter when leaving its lifecycle', () => {
    const adapter = configureAcpBackend({
      bridgeUrl: 'ws://localhost:23004',
      agentId: 'oh-my-pi',
    });
    const disconnect = vi.spyOn(adapter, 'disconnect');

    disconnectAcpBackend();

    expect(disconnect).toHaveBeenCalledOnce();
  });
});
