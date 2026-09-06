import { effectScope, nextTick, ref, type EffectScope } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useConnectedBridgeVersion,
  type ConnectedBridgeVersion,
} from './useConnectedBridgeVersion';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function flush() {
  for (let round = 0; round < 6; round += 1) {
    await Promise.resolve();
    await nextTick();
  }
}

describe('useConnectedBridgeVersion', () => {
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

  it('reports the connected bridge version from a valid health payload', async () => {
    // Given: a health endpoint returning a valid vis_bridge payload.
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '0.7.10' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    // When: the composable watches a health URL.
    const url = ref('http://bridge.test/healthz');
    const { state } = scope.run(() => useConnectedBridgeVersion(url))!;
    await flush();

    // Then: the version is reported and credentials are never sent to the public endpoint.
    expect(state.value).toEqual({ status: 'ready', version: '0.7.10' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://bridge.test/healthz');
    expect(init?.credentials).toBe('omit');
  });

  it('shows an error instead of loading forever when the health request times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const result = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')));
    if (!result) throw new Error('Expected active scope');
    await vi.advanceTimersByTimeAsync(5000);
    expect(result.state.value).toEqual({ status: 'error' });
  });

  it('does not let a previous request timeout abort the replacement request', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => {
      if (options.signal) signals.push(options.signal);
      return new Promise<Response>(() => {});
    }));
    const url = ref('http://a.test/healthz');
    const result = scope.run(() => useConnectedBridgeVersion(url));
    if (!result) throw new Error('Expected active scope');
    await vi.advanceTimersByTimeAsync(3000);
    url.value = 'http://b.test/healthz';
    await nextTick();
    await vi.advanceTimersByTimeAsync(2000);
    expect(signals[1]?.aborted).toBe(false);
    expect(result.state.value).toEqual({ status: 'loading' });
  });

  it('marks the version unavailable when the bridge health does not report one', async () => {
    // Given: an old bridge whose health payload has no version field.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge' }))));

    // When: the composable fetches.
    const { state } = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')))!;
    await flush();

    // Then: the state is explicitly unavailable and carries no version to fall back to.
    expect(state.value).toEqual({ status: 'unavailable' });
  });

  it('marks the version unavailable when the payload is not a vis_bridge health', async () => {
    // Given: a reachable endpoint that is not a vis_bridge health response.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ ok: true, service: 'other' }))));

    const { state } = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')))!;
    await flush();

    expect(state.value).toEqual({ status: 'unavailable' });
  });

  it('reports an error when the fetch rejects', async () => {
    // Given: a failing health endpoint.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));

    const { state } = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')))!;
    await flush();

    expect(state.value).toEqual({ status: 'error' });
  });

  it('reports an error when the endpoint answers with a non-ok status', async () => {
    // Given: a health endpoint answering 503.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({}, 503))));

    const { state } = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')))!;
    await flush();

    expect(state.value).toEqual({ status: 'error' });
  });

  it('stays disconnected without fetching when there is no health URL', async () => {
    // Given: no connected bridge.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { state } = scope.run(() => useConnectedBridgeVersion(ref('')))!;
    await flush();

    expect(state.value).toEqual({ status: 'disconnected' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a delayed response from the previous bridge overwrite nothing after switching', async () => {
    // Given: bridge A is slow and bridge B answers immediately.
    let resolveA: ((response: Response) => void) | undefined;
    let signalA: AbortSignal | undefined;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('a.test')) {
        signalA = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveA = resolve;
        });
      }
      return Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const url = ref('http://a.test/healthz');
    const { state } = scope.run(() => useConnectedBridgeVersion(url))!;
    await flush();

    // When: the connection switches to bridge B before A answers.
    url.value = 'http://b.test/healthz';
    await flush();

    // Then: B's version wins and A's in-flight request was aborted.
    expect(state.value).toEqual({ status: 'ready', version: '2.0.0' });
    expect(signalA?.aborted).toBe(true);

    // And: A's late response cannot overwrite the current bridge version.
    resolveA?.(jsonResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }));
    await flush();
    expect(state.value).toEqual({ status: 'ready', version: '2.0.0' });
  });

  it('clears the version when the bridge disconnects', async () => {
    // Given: a connected bridge that reported its version.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '0.7.10' }))));
    const url = ref('http://bridge.test/healthz');
    const { state } = scope.run(() => useConnectedBridgeVersion(url))!;
    await flush();
    expect(state.value).toEqual({ status: 'ready', version: '0.7.10' });

    // When: the bridge disconnects.
    url.value = '';
    await flush();

    // Then: no stale version remains.
    expect(state.value).toEqual({ status: 'disconnected' });
  });

  it('never writes state after the owning scope is disposed', async () => {
    // Given: an in-flight fetch when the scope is disposed.
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    const { state } = scope.run(() => useConnectedBridgeVersion(ref('http://bridge.test/healthz')))!;
    await flush();
    expect(state.value).toEqual({ status: 'loading' });

    // When: the scope is disposed and the fetch resolves late.
    scope.stop();
    resolveFetch?.(jsonResponse({ ok: true, service: 'vis_bridge', version: '0.7.10' }));
    await flush();

    // Then: the late response is discarded.
    expect(state.value).toEqual({ status: 'loading' });
  });
});

describe('useConnectedBridgeVersion connection reporting', () => {
  let scope: EffectScope;
  let reports: Array<{ connectionId: string; state: ConnectedBridgeVersion }>;

  function collect(connectionId: string, state: ConnectedBridgeVersion) {
    reports.push({ connectionId, state });
  }

  beforeEach(() => {
    scope = effectScope();
    reports = [];
  });

  afterEach(() => {
    scope.stop();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reports a loading connection with a fresh id before the ready version', async () => {
    // Given: a healthy bridge endpoint.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '1.2.3' })),
    ));

    // When: the composable connects.
    scope.run(() =>
      useConnectedBridgeVersion(ref('http://bridge.test/healthz'), { onConnectionChange: collect }),
    );
    await flush();

    // Then: a fresh connection id reported loading first, then the ready version.
    expect(reports).toHaveLength(2);
    expect(reports[0]!.state).toEqual({ status: 'loading' });
    expect(reports[1]!.state).toEqual({ status: 'ready', version: '1.2.3' });
    expect(reports[0]!.connectionId).not.toBe('');
    expect(reports[0]!.connectionId).toBe(reports[1]!.connectionId);
  });

  it('reports a failure state when the health fetch fails', async () => {
    // Given: a failing health endpoint.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connection refused'))));

    scope.run(() =>
      useConnectedBridgeVersion(ref('http://bridge.test/healthz'), { onConnectionChange: collect }),
    );
    await flush();

    // Then: the connection reported loading, then the failure.
    expect(reports.map((entry) => entry.state.status)).toEqual(['loading', 'error']);
    expect(reports[0]!.connectionId).toBe(reports[1]!.connectionId);
  });

  it('creates a fresh connection id on every refresh and re-reports the lifecycle', async () => {
    // Given: a connected bridge that already reported its version.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '1.2.3' })),
    ));
    const handle = scope.run(() =>
      useConnectedBridgeVersion(ref('http://bridge.test/healthz'), { onConnectionChange: collect }),
    )!;
    await flush();
    expect(reports).toHaveLength(2);
    const firstConnectionId = reports[0]!.connectionId;

    // When: the health is explicitly refreshed.
    await handle.refresh();

    // Then: a new connection id reported loading then ready again.
    expect(reports).toHaveLength(4);
    expect(reports[2]!.state).toEqual({ status: 'loading' });
    expect(reports[3]!.state).toEqual({ status: 'ready', version: '1.2.3' });
    expect(reports[2]!.connectionId).toBe(reports[3]!.connectionId);
    expect(reports[2]!.connectionId).not.toBe(firstConnectionId);
  });

  it('never reports a stale generation after the health url changes', async () => {
    // Given: bridge A answers slowly while bridge B answers immediately.
    let resolveA: ((response: Response) => void) | undefined;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input).includes('a.test')) {
        return new Promise<Response>((resolve) => { resolveA = resolve; });
      }
      return Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '2.0.0' }));
    }));
    const url = ref('http://a.test/healthz');
    scope.run(() => useConnectedBridgeVersion(url, { onConnectionChange: collect }));
    await flush();
    const connectionA = reports[0]!.connectionId;

    // When: the connection switches to B before A answers.
    url.value = 'http://b.test/healthz';
    await flush();

    // And: A's late response arrives afterwards.
    resolveA?.(jsonResponse({ ok: true, service: 'vis_bridge', version: '1.0.0' }));
    await flush();

    // Then: no ready report for the stale generation A ever reaches the listener.
    const readyReports = reports.filter((entry) => entry.state.status === 'ready');
    expect(readyReports).toHaveLength(1);
    expect(readyReports[0]!.state).toEqual({ status: 'ready', version: '2.0.0' });
    expect(readyReports[0]!.connectionId).not.toBe(connectionA);
    expect(
      reports.some(
        (entry) => entry.connectionId === connectionA && entry.state.status !== 'loading',
      ),
    ).toBe(false);
  });

  it('reports a disconnect on disposal without mutating the visible state', async () => {
    // Given: a connected bridge that reported its version.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '0.7.10' })),
    ));
    const { state } = scope.run(() =>
      useConnectedBridgeVersion(ref('http://bridge.test/healthz'), { onConnectionChange: collect }),
    )!;
    await flush();
    expect(state.value).toEqual({ status: 'ready', version: '0.7.10' });
    const connectionId = reports[0]!.connectionId;

    // When: the owning scope is disposed.
    scope.stop();

    // Then: the runtime is told the connection is gone, but the visible state stays put.
    expect(reports.at(-1)).toEqual({ connectionId, state: { status: 'disconnected' } });
    expect(state.value).toEqual({ status: 'ready', version: '0.7.10' });
  });

  it('reports a disconnect with the previous connection id when the bridge url clears', async () => {
    // Given: a connected bridge that reported its version.
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve(jsonResponse({ ok: true, service: 'vis_bridge', version: '0.7.10' })),
    ));
    const url = ref('http://bridge.test/healthz');
    scope.run(() => useConnectedBridgeVersion(url, { onConnectionChange: collect }));
    await flush();
    const connectionId = reports[0]!.connectionId;

    // When: the bridge disconnects.
    url.value = '';
    await flush();

    // Then: the old connection is reported as disconnected.
    expect(reports.at(-1)).toEqual({ connectionId, state: { status: 'disconnected' } });
  });
});
