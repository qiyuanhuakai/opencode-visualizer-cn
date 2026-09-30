import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ACP_BRIDGE_URL,
  DEFAULT_CODEX_BRIDGE_URL,
  DEFAULT_DSH_BRIDGE_URL,
  DEFAULT_KIMI_WEB_BRIDGE_URL,
  configureDshBackend,
  disconnectDshBackend,
  getActiveBackendKind,
  getBackendAdapter,
  registerDshAdapterFactory,
  setActiveBackendKind,
} from './registry';
import type { BackendAdapter } from './types';

// Todo 15 owns the real `createDshAdapter`; until then the registry exposes a
// factory seam and these tests inject a stub. The stub records every instance
// so memo-by-key and rebuild-on-token-change are observable without the real
// adapter.
const created: BackendAdapter[] = [];

function makeStubAdapter(): BackendAdapter {
  return {
    kind: 'dsh',
    label: 'dsh-stub',
    disconnect: vi.fn(),
  } as unknown as BackendAdapter;
}

describe('dsh backend registry', () => {
  beforeEach(() => {
    created.length = 0;
    setActiveBackendKind('opencode');
    registerDshAdapterFactory(() => {
      const adapter = makeStubAdapter();
      created.push(adapter);
      return adapter;
    });
  });

  it('exposes the dsh bridge URL default without changing the other backend defaults', () => {
    expect(DEFAULT_DSH_BRIDGE_URL).toBe('ws://localhost:23004/dsh/ws');
    expect(DEFAULT_CODEX_BRIDGE_URL).toBe('ws://localhost:23004/codex');
    expect(DEFAULT_ACP_BRIDGE_URL).toBe('ws://localhost:23004');
    expect(DEFAULT_KIMI_WEB_BRIDGE_URL).toBe('ws://localhost:23004/kimi-web/ws');
  });

  it('refuses the dsh adapter before it is configured and returns it after', () => {
    // Given: the dsh factory is registered but the slot is still empty.
    // Then: the slot refuses — a registered factory is not the same as a configured adapter.
    expect(() => getBackendAdapter('dsh')).toThrow('Backend adapter is not registered: dsh');

    // When: the dsh bridge is configured.
    const adapter = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL });

    // Then: the slot returns that exact adapter without changing active identity.
    expect(getBackendAdapter('dsh')).toBe(adapter);
    expect(adapter).toEqual(expect.objectContaining({ kind: 'dsh' }));
    expect(getActiveBackendKind()).toBe('opencode');
  });

  it('rejects an empty or whitespace-only dsh bridge URL', () => {
    expect(() => configureDshBackend({ bridgeUrl: '' })).toThrow('dsh bridge URL is required.');
    expect(() => configureDshBackend({ bridgeUrl: '   ' })).toThrow('dsh bridge URL is required.');
  });

  it('rejects an invalid dsh bridge URL instead of silently falling back', () => {
    expect(() => configureDshBackend({ bridgeUrl: 'not a url' })).toThrow();
    expect(() => configureDshBackend({ bridgeUrl: 'http://localhost:23004/dsh/ws' })).toThrow();
  });

  it('returns the same instance when reconfigured with identical parameters', () => {
    // Given: a configured dsh bridge.
    const first = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL, bridgeToken: 'secret' });
    const memoCalls = created.length;

    // When: the same bridge parameters are configured again.
    const second = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL, bridgeToken: 'secret' });

    // Then: the memoized instance is reused and no new adapter is built.
    expect(second).toBe(first);
    expect(created.length).toBe(memoCalls);
    expect(created.length).toBe(1);
  });

  it('rebuilds a new instance when the bridge token changes', () => {
    // Given: a configured dsh bridge.
    const first = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL, bridgeToken: 'one' });

    // When: only the token changes.
    const second = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL, bridgeToken: 'two' });

    // Then: a fresh adapter replaces the stale one.
    expect(second).not.toBe(first);
    expect(created.length).toBe(2);
    expect(getBackendAdapter('dsh')).toBe(second);
  });

  it('clears the slot and closes the instance on disconnect', () => {
    // Given: a configured dsh adapter.
    const adapter = configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL });

    // When: the dsh backend is disconnected.
    disconnectDshBackend();

    // Then: the transport is closed and the slot no longer resolves.
    expect(adapter.disconnect).toHaveBeenCalledTimes(1);
    expect(() => getBackendAdapter('dsh')).toThrow('Backend adapter is not registered: dsh');
  });

  it('refuses to configure when no dsh adapter factory is registered', () => {
    registerDshAdapterFactory(undefined);
    expect(() => configureDshBackend({ bridgeUrl: DEFAULT_DSH_BRIDGE_URL })).toThrow(
      'dsh adapter factory is not registered.',
    );
  });
});
