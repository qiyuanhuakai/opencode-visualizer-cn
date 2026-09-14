import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';
// allow: SIZE_OK — bridge health races and report-before-check failures form one state machine.
import {
  registerDesktopSettingsLifecycle,
  en,
  makeState,
  createDesktopApi,
  flushAsync,
  cardFor,
  cardButton,
  healthResponse,
  mountWithBridgeUrl,
} from './DesktopSettings.shared';

registerDesktopSettingsLifecycle();

describe('DesktopSettings bridge health', () => {
  it('shows the connected bridge version instead of the local installed version', async () => {
    // Given: the local installed bridge is 0.7.9 but the connected bridge reports 9.9.9.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const fetchMock = vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '9.9.9' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    // When: the settings section mounts with a connected bridge health URL.
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // Then: the connected version is fetched and shown distinctly from the local version.
    expect(fetchMock).toHaveBeenCalledWith(
      'http://bridge.test/healthz',
      expect.objectContaining({ credentials: 'omit' }),
    );
    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).not.toContain('0.7.9');
    expect(bridgeCard.textContent).toContain(`${en.updates.connectedBridge.label}: 9.9.9`);
  });

  it('keeps a remote connected version visible without local updater actions', async () => {
    const desktop = createDesktopApi(
      makeState({
        bridge: {
          currentVersion: '9.9.9',
          installKind: 'remote',
          phase: 'unsupported',
        },
      }),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '9.9.9' })),
      ),
    );

    const { host } = await mountWithBridgeUrl('https://bridge.example.com/healthz').mount();
    await flushAsync();

    const bridgeCard = cardFor(host, 'bridge');
    expect(bridgeCard.textContent).toContain(`${en.updates.connectedBridge.label}: 9.9.9`);
    expect(bridgeCard.textContent).toContain(en.updates.remoteUpdateUnavailableNotice);
    expect(
      bridgeCard.querySelector('[data-testid="bridge-remote-update-unavailable"]'),
    ).not.toBeNull();
    expect(bridgeCard.querySelector('button')).toBeNull();
  });

  it('marks the connected version unavailable when the old bridge health reports no version', async () => {
    // Given: an old bridge whose health payload lacks a version field.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge' }))),
    );

    // When: the settings section mounts.
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // Then: the connected row is explicitly unavailable and never mirrors the local version.
    const bridgeCard = cardFor(host, 'bridge');
    const connectedRow = bridgeCard.querySelector('[data-testid="bridge-connected-version"]');
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.unavailable);
    expect(connectedRow?.textContent).not.toContain('0.7.9');
    expect(bridgeCard.textContent).not.toContain('0.7.9');
  });

  it('ignores a delayed response from the previous bridge after switching backends', async () => {
    // Given: bridge A answers slowly while bridge B answers immediately.
    let resolveA: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((input: string | URL | Request) => {
        if (String(input).includes('a.test')) {
          return new Promise<Response>((resolve) => {
            resolveA = resolve;
          });
        }
        return Promise.resolve(
          healthResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }),
        );
      }),
    );
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });

    // When: the connected backend switches from A to B before A answers.
    const mounted = mountWithBridgeUrl('http://a.test/healthz');
    const { host } = await mounted.mount();
    await flushAsync();
    mounted.url.value = 'http://b.test/healthz';
    await flushAsync();

    // Then: B's version is shown.
    const bridgeCard = () => cardFor(host, 'bridge');
    expect(bridgeCard().textContent).toContain(`${en.updates.connectedBridge.label}: 2.0.0`);

    // And: A's late response cannot overwrite it.
    resolveA?.(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }));
    await flushAsync();
    expect(bridgeCard().textContent).toContain(`${en.updates.connectedBridge.label}: 2.0.0`);
    expect(bridgeCard().textContent).not.toContain('1.0.0');
  });

  it('clears the connected version when the bridge disconnects', async () => {
    // Given: a connected bridge that already reported its version.
    const desktop = createDesktopApi(makeState({ bridge: { currentVersion: '0.7.9' } }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '9.9.9' })),
      ),
    );
    const mounted = mountWithBridgeUrl('http://bridge.test/healthz');
    const { host } = await mounted.mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(
      `${en.updates.connectedBridge.label}: 9.9.9`,
    );

    // When: the bridge disconnects.
    mounted.url.value = '';
    await flushAsync();

    // Then: no stale version remains and the not-connected state is visible.
    const connectedRow = cardFor(host, 'bridge').querySelector(
      '[data-testid="bridge-connected-version"]',
    );
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.notConnected);
    expect(connectedRow?.textContent).not.toContain('9.9.9');
  });

  it('refreshes health and reports the fresh version before a manual bridge check', async () => {
    // Given: a connected bridge at 1.0.0 that is then externally upgraded at the same URL.
    let version = '1.0.0';
    const fetchMock = vi.fn(() =>
      Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const desktop = createDesktopApi(makeState());
    const order: string[] = [];
    desktop.api.reportBridgeVersion = vi.fn((report) => {
      order.push(`report:${report.version ?? 'null'}`);
      return Promise.resolve(makeState());
    });
    desktop.api.check = vi.fn(() => {
      order.push('check');
      return Promise.resolve(makeState());
    });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(
      `${en.updates.connectedBridge.label}: 1.0.0`,
    );

    // When: the user checks for bridge updates after the external upgrade.
    version = '2.0.0';
    const checkButton = cardButton(cardFor(host, 'bridge'), en.updates.actions.check);
    expect(checkButton).toBeDefined();
    checkButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();

    // Then: health was re-fetched, the fresh version reached the runtime BEFORE the check ran.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(order.slice(-2)).toEqual(['report:2.0.0', 'check']);
    expect(desktop.api.check).toHaveBeenCalledWith('bridge');
    expect(cardFor(host, 'bridge').textContent).toContain(
      `${en.updates.connectedBridge.label}: 2.0.0`,
    );
  });

  it('does not run the native check when the health refresh fails', async () => {
    // Given: a bridge that was connected and then goes down.
    let failing = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        failing
          ? Promise.reject(new Error('connection refused'))
          : Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
      ),
    );
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();
    expect(cardFor(host, 'bridge').textContent).toContain(
      `${en.updates.connectedBridge.label}: 1.0.0`,
    );

    // When: the user checks for updates while the bridge is unreachable.
    failing = true;
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flushAsync();

    // Then: the stale version is not trusted, no check ran, and the error stays visible.
    expect(desktop.api.check).not.toHaveBeenCalled();
    const connectedRow = cardFor(host, 'bridge').querySelector(
      '[data-testid="bridge-connected-version"]',
    );
    expect(connectedRow?.textContent).toContain(en.updates.connectedBridge.error);
  });

  it('does not run the native check when the runtime cannot accept version reports', async () => {
    // Given: a legacy desktop runtime without the reportBridgeVersion API.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
      ),
    );
    const desktop = createDesktopApi(makeState());
    delete desktop.api.reportBridgeVersion;
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flushAsync();

    // Then: without a fresh accepted report there is no check.
    expect(desktop.api.check).not.toHaveBeenCalled();
  });

  it('does not run the native check when the version report is rejected', async () => {
    // Given: a healthy bridge but a runtime whose report call fails.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' })),
      ),
    );
    const desktop = createDesktopApi(makeState());
    desktop.api.reportBridgeVersion = vi.fn(() => Promise.reject(new Error('ipc down')));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await flushAsync();

    // Then: the rejected report blocks the check.
    expect(desktop.api.check).not.toHaveBeenCalled();
  });

  it('keeps the bridge actions busy while the manual health refresh is in flight', async () => {
    // Given: a bridge whose refresh response is delayed.
    let resolveRefresh: ((response: Response) => void) | undefined;
    let calls = 0;
    const fetchMock = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(
          healthResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }),
        );
      }
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const desktop = createDesktopApi(makeState());
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { desktop: desktop.api },
    });
    const { host } = await mountWithBridgeUrl('http://bridge.test/healthz').mount();
    await flushAsync();

    // When: the user checks for bridge updates and clicks again mid-refresh.
    cardButton(cardFor(host, 'bridge'), en.updates.actions.check)!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await nextTick();

    // Then: one refresh is in flight, every bridge action is disabled, and no duplicate starts.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const buttons = Array.from(
      cardFor(host, 'bridge').querySelectorAll('button'),
    ) as HTMLButtonElement[];
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) expect(button.disabled).toBe(true);
    buttons[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(desktop.api.check).not.toHaveBeenCalled();

    // And: once the refresh answers, the check proceeds.
    resolveRefresh?.(healthResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }));
    await flushAsync();
    expect(desktop.api.check).toHaveBeenCalledWith('bridge');
  });
});
