import { describe, expect, it, vi } from 'vitest';

import { mountRuntimeApp } from './test/runtimeAppHarness';
import { StorageKeys, storageKey } from './utils/storageKeys';

describe('Bridge login and logout isolation', () => {
  it('exposes only the Bridge address and token fields', async () => {
    const fixture = await mountRuntimeApp([]);
    const form = fixture.element.querySelector<HTMLFormElement>('[data-testid=bridge-login]')!;
    expect([...form.querySelectorAll('input')].map(input => [input.name, input.type])).toEqual([
      ['bridgeUrl', 'text'],
      ['bridgeToken', 'password'],
    ]);
    expect(form.querySelector<HTMLInputElement>('#bridge-url')?.value).toBe('ws://127.0.0.1:4096/runtime');
    expect(fixture.element.querySelector('.app-login-backend')).toBeNull();
  }, 15000);

  it('clears the Bridge token on logout, keeps its URL, and preserves old Agent credentials for migration', async () => {
    const bridgeToken = 'fixture-bridge-token';
    const fixture = await mountRuntimeApp([], { bridgeToken });
    const legacyKeys = [
      StorageKeys.auth.credentials,
      StorageKeys.auth.codexBridgeToken,
      StorageKeys.auth.acpBridgeToken,
      StorageKeys.auth.kimiWebBridgeToken,
      StorageKeys.auth.dshBridgeToken,
    ].map(storageKey);
    for (const [index, key] of legacyKeys.entries()) localStorage.setItem(key, `legacy-${index}`);

    await fixture.connect();
    await fixture.select('Session A');
    await vi.waitFor(() => expect(fixture.historyOpens.at(-1)?.nativeSessionId).toBe('session-a'));
    fixture.element.querySelector<HTMLButtonElement>('.logout-button')!.click();
    await vi.waitFor(() => {
      expect(fixture.element.querySelector('.top-panel')).toBeNull();
      expect(fixture.element.querySelector<HTMLInputElement>('#bridge-url')?.value).toBe(fixture.endpoint);
      expect(fixture.element.querySelector<HTMLInputElement>('#bridge-token')?.value).toBe('');
    });
    for (const [index, key] of legacyKeys.entries()) expect(localStorage.getItem(key)).toBe(`legacy-${index}`);

    await fixture.submitBridgeLogin('');
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid=bridge-login] [role=alert]')).toBeTruthy());
    expect(fixture.element.querySelector('.top-panel')).toBeNull();
    await fixture.connect();
    expect(fixture.element.querySelector('.top-panel')).toBeTruthy();
  }, 15000);
});
