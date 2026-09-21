import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ACP_BRIDGE_URL,
  DEFAULT_CODEX_BRIDGE_URL,
  DEFAULT_KIMI_WEB_BRIDGE_URL,
  KIMI_WEB_CAPABILITIES,
  configureKimiWebBackend,
  getActiveBackendAdapter,
  getActiveBackendKind,
  getBackendAdapter,
  kimiWebBridgeHttpUrl,
  setActiveBackendKind,
} from './registry';
import { StorageKeys, storageRemove } from '../utils/storageKeys';

describe('Kimi Web backend registry', () => {
  beforeEach(() => {
    storageRemove(StorageKeys.auth.backendKind);
    setActiveBackendKind('opencode');
  });

  it('exposes a kimi-web bridge URL default without changing the Codex and ACP defaults', () => {
    // Given: the registry's transport defaults.
    // Then: kimi-web has its own default and the existing backends keep theirs byte-identical.
    expect(DEFAULT_KIMI_WEB_BRIDGE_URL).toBe('ws://localhost:23004/kimi-web/ws');
    expect(DEFAULT_CODEX_BRIDGE_URL).toBe('ws://localhost:23004/codex');
    expect(DEFAULT_ACP_BRIDGE_URL).toBe('ws://localhost:23004');
  });

  it('derives the bridge HTTP URL from a kimi-web WebSocket URL', () => {
    // Given: kimi-web bridge endpoints on ws and wss.
    // When/Then: the protocol is swapped and the path is preserved.
    expect(kimiWebBridgeHttpUrl('ws://localhost:23004/kimi-web/ws')).toBe(
      'http://localhost:23004/kimi-web/ws',
    );
    expect(kimiWebBridgeHttpUrl('wss://bridge.example.com:9300/kimi-web/ws')).toBe(
      'https://bridge.example.com:9300/kimi-web/ws',
    );
  });

  it('rejects a kimi-web bridge URL that is not a WebSocket transport', () => {
    expect(() => kimiWebBridgeHttpUrl('http://localhost:23004/kimi-web/ws')).toThrow(
      'Unsupported Kimi Web bridge URL protocol',
    );
  });

  it('accepts a valid kimi-web configuration without exposing a production adapter', () => {
    // Given: a configured Kimi Web bridge whose adapter is still the Todo 25 placeholder.
    // When: the bridge credentials are configured.
    expect(() =>
      configureKimiWebBackend({
        bridgeUrl: DEFAULT_KIMI_WEB_BRIDGE_URL,
        bridgeToken: 'bridge-secret',
      }),
    ).not.toThrow();

    // Then: no production path can obtain the placeholder adapter.
    expect(() => getBackendAdapter('kimi-web')).toThrow(
      'Backend adapter is not registered: kimi-web',
    );
    expect(getActiveBackendKind()).toBe('opencode');
  });

  it('rejects an empty kimi-web bridge URL', () => {
    expect(() => configureKimiWebBackend({ bridgeUrl: '   ' })).toThrow(
      'Kimi Web bridge URL is required.',
    );
  });

  it('rejects an invalid kimi-web bridge URL instead of silently falling back', () => {
    expect(() => configureKimiWebBackend({ bridgeUrl: 'not a url' })).toThrow();
    expect(() => configureKimiWebBackend({ bridgeUrl: 'http://localhost:23004' })).toThrow(
      'Unsupported Kimi Web bridge URL protocol',
    );
  });

  it('publishes only the measured kimi-web capability subset', () => {
    // Given: the measured kimi-web surface in docs/kimi.md.
    // Then: core session/approval/status features are on...
    expect(KIMI_WEB_CAPABILITIES.sessions).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.sessionRename).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.sessionArchive).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.sessionUnarchive).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.sessionDelete).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.permissions).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.questions).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.status).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.files).toBe(true);
    expect(KIMI_WEB_CAPABILITIES.providerConfig).toBe(true);

    // ...while actions gated by runtime probing (Todo 21) and out-of-scope surfaces stay off.
    expect(KIMI_WEB_CAPABILITIES.sessionFork).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.sessionRevert).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.sessionCompact).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.sessionPin).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.sessionUnpin).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.terminal).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.worktrees).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.todos).toBe(false);
    expect(KIMI_WEB_CAPABILITIES.sessionManagementMode).toBe('standard');
  });

  it('keeps kimi-web unactivatable so getActiveBackendAdapter keeps rejecting', () => {
    // Given: a configured kimi-web bridge.
    configureKimiWebBackend({ bridgeUrl: DEFAULT_KIMI_WEB_BRIDGE_URL });

    // When: a caller tries to activate the unregistered backend.
    // Then: activation is rejected and the active adapter is untouched.
    expect(() => setActiveBackendKind('kimi-web')).toThrow(
      'Backend adapter is not registered: kimi-web',
    );
    expect(getActiveBackendAdapter()).toEqual(expect.objectContaining({ kind: 'opencode' }));
  });
});
