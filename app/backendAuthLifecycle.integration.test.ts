import { describe, expect, it, vi } from 'vitest';

import { mountRuntimeApp } from './test/runtimeAppHarness';
import { StorageKeys, storageKey } from './utils/storageKeys';

const bridgeToken = 'test-bridge-authentication';

describe('App Bridge authentication lifecycle', () => {
  it.each(['', 'test-rejected-token'])(
    'stays on Bridge login after a rejected token and recovers on retry (%j)',
    async (rejectedToken) => {
      const fixture = await mountRuntimeApp([], { bridgeToken });
      await fixture.submitBridgeLogin(rejectedToken);
      await vi.waitFor(() => {
        expect(fixture.element.querySelector('[data-testid=bridge-login] [role=alert]')?.textContent?.trim()).toBeTruthy();
        expect(fixture.element.querySelector('.top-panel')).toBeNull();
      });
      expect(fixture.historyOpens).toEqual([]);

      await fixture.connect();
      await fixture.select('Session A');
      await vi.waitFor(() => expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-a'));
      expect(Object.values(localStorage).join('\n')).not.toContain(bridgeToken);
    },
    15000,
  );

  it('does not use legacy Agent credentials as the Bridge token or alter the migration source', async () => {
    const fixture = await mountRuntimeApp([], { bridgeToken });
    const legacyKeys = [
      StorageKeys.auth.credentials,
      StorageKeys.auth.codexBridgeToken,
      StorageKeys.auth.acpBridgeToken,
    ].map(storageKey);
    for (const key of legacyKeys) localStorage.setItem(key, bridgeToken);

    await fixture.submitBridgeLogin('');
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid=bridge-login] [role=alert]')).toBeTruthy());
    expect(fixture.element.querySelector('.top-panel')).toBeNull();
    for (const key of legacyKeys) expect(localStorage.getItem(key)).toBe(bridgeToken);

    await fixture.connect();
    expect(fixture.element.querySelector('.top-panel')).toBeTruthy();
    for (const key of legacyKeys) expect(localStorage.getItem(key)).toBe(bridgeToken);
  }, 15000);
});
