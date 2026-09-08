import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopApi, DesktopBridgeVersionReport, DesktopState } from '../types/desktop';
import {
  resolveDesktopBridgeHealthUrl,
  useDesktopBridgeVersion,
} from './useDesktopBridgeVersion';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function healthPayload(version: string) {
  return jsonResponse({ ok: true, service: 'vis_bridge', version });
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

function makeState(): DesktopState {
  return {
    preferences: {
      locale: 'en',
      minimizeToTray: true,
      closeToTray: false,
      autoCheckUpdates: true,
      autoDownloadUpdates: false,
      idleNotifications: true,
      notificationSound: false,
    },
    trayAvailable: true,
    nativeNotificationsAvailable: true,
    updates: {
      app: {
        component: 'app',
        currentVersion: '1.4.0',
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'automatic',
        assetName: null,
      },
      bridge: {
        component: 'bridge',
        currentVersion: null,
        availableVersion: null,
        phase: 'idle',
        progress: null,
        error: null,
        installKind: 'manual',
        assetName: null,
      },
    },
  };
}

function createDesktopApi() {
  const reports: DesktopBridgeVersionReport[] = [];
  const api: DesktopApi = {
    getState: vi.fn(() => Promise.resolve(makeState())),
    configure: vi.fn(() => Promise.resolve(makeState())),
    reportBridgeVersion: vi.fn((report: DesktopBridgeVersionReport) => {
      reports.push(report);
      return Promise.resolve(makeState());
    }),
    check: vi.fn(() => Promise.resolve(makeState())),
    download: vi.fn(() => Promise.resolve(makeState())),
    install: vi.fn(() => Promise.resolve(makeState())),
    notify: vi.fn(() => Promise.resolve()),
    onState: vi.fn(() => () => {}),
    onNotificationClick: vi.fn(() => () => {}),
  };
  return { api, reports };
}

describe('resolveDesktopBridgeHealthUrl', () => {
  it('uses the configured common bridge for the OpenCode backend, never the OpenCode server', () => {
    // Given: an OpenCode backend whose server lives on :4096 while the common bridge is configured.
    const url = resolveDesktopBridgeHealthUrl({
      backendKind: 'opencode',
      acpBridgeUrl: 'ws://localhost:23004',
      acpBridgeToken: '',
      codexBridgeUrl: 'ws://localhost:23004/codex',
      codexBridgeToken: 'shared-secret',
    });

    // Then: the health URL targets the configured common bridge with its token, not :4096.
    expect(url).toBe('http://localhost:23004/healthz?token=shared-secret');
    expect(url).not.toContain('4096');
  });

  it('uses the configured common bridge for the Codex backend', () => {
    const url = resolveDesktopBridgeHealthUrl({
      backendKind: 'codex',
      acpBridgeUrl: 'ws://localhost:23004',
      acpBridgeToken: '',
      codexBridgeUrl: 'wss://bridge.example.com:9300/codex',
      codexBridgeToken: 'codex-token',
    });

    expect(url).toBe('https://bridge.example.com:9300/healthz?token=codex-token');
  });

  it('uses the configured ACP bridge for the ACP backend', () => {
    const url = resolveDesktopBridgeHealthUrl({
      backendKind: 'acp',
      acpBridgeUrl: 'ws://acp.example.com:9400',
      acpBridgeToken: 'acp-token',
      codexBridgeUrl: 'ws://localhost:23004/codex',
      codexBridgeToken: 'codex-token',
    });

    expect(url).toBe('http://acp.example.com:9400/healthz?token=acp-token');
  });

  it('returns no health url when the configured bridge url is invalid', () => {
    const url = resolveDesktopBridgeHealthUrl({
      backendKind: 'opencode',
      acpBridgeUrl: 'ws://localhost:23004',
      acpBridgeToken: '',
      codexBridgeUrl: 'not a url',
      codexBridgeToken: '',
    });

    expect(url).toBe('');
  });
});

describe('useDesktopBridgeVersion', () => {
  let scope: EffectScope;

  beforeEach(() => {
    scope = effectScope();
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports null with a fresh connection id, then the ready version, to the desktop runtime', async () => {
    // Given: a desktop runtime accepting bridge version reports and a healthy bridge.
    const desktop = createDesktopApi();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('1.2.3'))));

    // When: the hook connects.
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();

    // Then: the runtime saw null first, then the ready version, on one connection id.
    expect(desktop.reports).toHaveLength(2);
    expect(desktop.reports[0]).toEqual({
      connectionId: desktop.reports[1]!.connectionId,
      endpointLocality: 'remote',
      version: null,
    });
    expect(desktop.reports[1]).toEqual({
      connectionId: desktop.reports[0]!.connectionId,
      endpointLocality: 'remote',
      version: '1.2.3',
    });
    expect(desktop.reports[1]!.version).toBe('1.2.3');
    expect(handle.state.value).toEqual({ status: 'ready', version: '1.2.3' });
  });

  it('clears native bridge metadata on a fresh owner with no connection', async () => {
    const desktop = createDesktopApi();
    scope.run(() => useDesktopBridgeVersion(ref(''), desktop.api));
    await flush();
    expect(desktop.reports).toEqual([
      { connectionId: expect.any(String), endpointLocality: 'unknown', version: null },
    ]);
    expect(desktop.reports[0]?.connectionId).not.toBe('');
  });

  it('rejects a refresh superseded while its native report is pending', async () => {
    const desktop = createDesktopApi();
    let holdNext = false;
    let accept: ((value: DesktopState) => void) | undefined;
    const pending = new Promise<DesktopState>((resolve) => { accept = resolve; });
    desktop.api.reportBridgeVersion = vi.fn((report) => {
      if (holdNext && report.version !== null) {
        holdNext = false;
        return pending;
      }
      return Promise.resolve(makeState());
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('1.2.3'))));
    const url = ref('http://bridge.test/healthz');
    const handle = scope.run(() => useDesktopBridgeVersion(url, desktop.api));
    if (!handle) throw new Error('Expected active scope');
    await flush();
    holdNext = true;
    const checking = handle.refresh();
    await flush();
    url.value = '';
    await flush();
    accept?.(makeState());
    expect(await checking).toBe(false);
  });

  it('reports null when the health check fails', async () => {
    // Given: an unreachable bridge.
    const desktop = createDesktopApi();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));

    scope.run(() => useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api));
    await flush();

    // Then: the runtime only ever received null versions, so it cannot offer an update.
    expect(desktop.reports.length).toBeGreaterThanOrEqual(2);
    expect(desktop.reports.every((report) => report.version === null)).toBe(true);
  });

  it('reports null on disposal so the runtime stops offering work for the closed connection', async () => {
    // Given: a connected bridge that reported its version.
    const desktop = createDesktopApi();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('0.7.10'))));
    scope.run(() => useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api));
    await flush();
    const connectionId = desktop.reports[0]!.connectionId;

    // When: the owning scope is disposed.
    scope.stop();

    // Then: the runtime receives a final null for that connection.
    expect(desktop.reports.at(-1)).toEqual({
      connectionId,
      endpointLocality: 'remote',
      version: null,
    });
  });

  it.each([
    'http://localhost:23004/healthz',
    'http://localhost.:23004/healthz',
    'http://127.42.0.9:23004/healthz',
    'http://[::1]:23004/healthz',
    'http://[::ffff:127.0.0.1]:23004/healthz',
  ])('reports local endpoint locality for loopback bridge URL %s', async (healthUrl) => {
    const desktop = createDesktopApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(healthPayload('1.2.3'))),
    );

    scope.run(() => useDesktopBridgeVersion(ref(healthUrl), desktop.api));
    await flush();

    expect(desktop.reports.at(-1)?.endpointLocality).toBe('local');
  });

  it.each([
    'http://[::ffff:192.168.1.2]:23004/healthz',
    'http://127.evil.example:23004/healthz',
    'http://127.0.0.1.evil.example:23004/healthz',
  ])('reports non-loopback endpoint %s as remote', async (healthUrl) => {
    const desktop = createDesktopApi();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(healthPayload('1.2.3'))),
    );

    scope.run(() => useDesktopBridgeVersion(ref(healthUrl), desktop.api));
    await flush();

    expect(desktop.reports.at(-1)?.endpointLocality).toBe('remote');
  });

  it('keeps fetching health without reporting when the runtime lacks the report API', async () => {
    // Given: a legacy desktop runtime without reportBridgeVersion.
    const desktop = createDesktopApi();
    delete desktop.api.reportBridgeVersion;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('1.2.3'))));

    // When: the hook connects.
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();

    // Then: health still resolves for display, and nothing is reported.
    expect(handle.state.value).toEqual({ status: 'ready', version: '1.2.3' });
    expect(desktop.reports).toHaveLength(0);
  });

  it('refresh re-checks health, reports the fresh version, and resolves true once accepted', async () => {
    // Given: a bridge that is externally upgraded from 1.0.0 to 2.0.0 at the same URL.
    const desktop = createDesktopApi();
    let version = '1.0.0';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload(version))));
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();
    expect(handle.state.value).toEqual({ status: 'ready', version: '1.0.0' });
    const firstConnectionId = desktop.reports[0]!.connectionId;

    // When: a manual refresh runs against the upgraded bridge.
    version = '2.0.0';
    const ok = await handle.refresh();

    // Then: the fresh version was reported on a new connection and the refresh was accepted.
    expect(ok).toBe(true);
    expect(handle.state.value).toEqual({ status: 'ready', version: '2.0.0' });
    expect(desktop.reports.at(-1)!.version).toBe('2.0.0');
    expect(desktop.reports.at(-1)!.connectionId).not.toBe(firstConnectionId);
  });

  it('refresh resolves false when the health check fails', async () => {
    // Given: a bridge that was healthy and then goes down.
    const desktop = createDesktopApi();
    let failing = false;
    vi.stubGlobal('fetch', vi.fn(() =>
      failing
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(healthPayload('1.0.0')),
    ));
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();

    // When: a manual refresh runs against the dead bridge.
    failing = true;
    const ok = await handle.refresh();

    // Then: the refresh is not accepted and the runtime was told null.
    expect(ok).toBe(false);
    expect(handle.state.value).toEqual({ status: 'error' });
    expect(desktop.reports.at(-1)!.version).toBeNull();
  });

  it('refresh resolves false when the runtime rejects the version report', async () => {
    // Given: a healthy bridge but a runtime whose report call fails.
    const desktop = createDesktopApi();
    desktop.api.reportBridgeVersion = vi.fn(() => Promise.reject(new Error('ipc down')));
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('1.0.0'))));
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();

    // When: a manual refresh runs.
    const ok = await handle.refresh();

    // Then: the refresh is not accepted even though the bridge is healthy.
    expect(ok).toBe(false);
    expect(handle.state.value).toEqual({ status: 'ready', version: '1.0.0' });
  });

  it('refresh resolves false when the health url changes while the refresh is in flight', async () => {
    // Given: a bridge whose refresh response is delayed.
    const desktop = createDesktopApi();
    let resolveRefresh: ((response: Response) => void) | undefined;
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(healthPayload('1.0.0'));
      return new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
    }));
    const url = ref('http://bridge.test/healthz');
    const handle = scope.run(() => useDesktopBridgeVersion(url, desktop.api))!;
    await flush();

    // When: a refresh starts and the connection switches before it answers.
    const pending = handle.refresh();
    url.value = 'http://other.test/healthz';
    resolveRefresh?.(healthPayload('2.0.0'));
    const ok = await pending;
    await flush();

    // Then: the stale refresh is not accepted.
    expect(ok).toBe(false);
  });

  it('refresh resolves false without the report API instead of falling back to anything else', async () => {
    // Given: a legacy desktop runtime without reportBridgeVersion.
    const desktop = createDesktopApi();
    delete desktop.api.reportBridgeVersion;
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(healthPayload('1.0.0'))));
    const handle = scope.run(() =>
      useDesktopBridgeVersion(ref('http://bridge.test/healthz'), desktop.api),
    )!;
    await flush();

    // When: a manual refresh runs.
    const ok = await handle.refresh();

    // Then: there is nothing to accept the report, so the refresh is not accepted.
    expect(ok).toBe(false);
  });

  it('refresh resolves false when there is no connected bridge url', async () => {
    // Given: no configured bridge connection.
    const desktop = createDesktopApi();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const handle = scope.run(() => useDesktopBridgeVersion(ref(''), desktop.api))!;
    await flush();

    // When: a manual refresh runs.
    const ok = await handle.refresh();

    // Then: nothing was fetched and the refresh is not accepted.
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
