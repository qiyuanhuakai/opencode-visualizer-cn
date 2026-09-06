import { onScopeDispose, readonly, ref, watch, type Ref } from 'vue';

export type ConnectedBridgeVersion =
  | { status: 'disconnected' }
  | { status: 'loading' }
  | { status: 'ready'; version: string }
  | { status: 'unavailable' }
  | { status: 'error' };

export type ConnectedBridgeVersionReporter = (
  connectionId: string,
  state: ConnectedBridgeVersion,
) => void;

const HEALTH_TIMEOUT_MS = 5000;

function parseHealthVersion(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  if (!('ok' in body) || body.ok !== true || !('service' in body) || body.service !== 'vis_bridge') return null;
  return 'version' in body && typeof body.version === 'string' && body.version.trim() !== '' ? body.version : null;
}

export function useConnectedBridgeVersion(
  healthUrl: Ref<string>,
  options?: { onConnectionChange?: ConnectedBridgeVersionReporter },
) {
  const state = ref<ConnectedBridgeVersion>({ status: 'disconnected' });
  let generation = 0;
  let controller: AbortController | null = null;
  let connectionId = '';

  function report(next: ConnectedBridgeVersion) {
    if (!connectionId) return;
    options?.onConnectionChange?.(connectionId, next);
  }

  function invalidate() {
    generation += 1;
    controller?.abort();
    controller = null;
  }

  async function fetchVersion(url: string, current: number) {
    const requestController = new AbortController();
    controller = requestController;
    const signal = requestController.signal;
    const timer = setTimeout(() => {
      requestController.abort();
      if (current === generation) {
        state.value = { status: 'error' };
        report(state.value);
      }
    }, HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { credentials: 'omit', signal });
      if (signal.aborted || current !== generation) return;
      if (!response.ok) {
        state.value = { status: 'error' };
        report(state.value);
        return;
      }
      const version = parseHealthVersion(await response.json().catch(() => null));
      if (signal.aborted || current !== generation) return;
      state.value = version === null ? { status: 'unavailable' } : { status: 'ready', version };
      report(state.value);
    } catch {
      if (signal.aborted || current !== generation) return;
      state.value = { status: 'error' };
      report(state.value);
    } finally {
      clearTimeout(timer);
    }
  }

  function connect(url: string): Promise<void> {
    invalidate();
    const trimmed = url.trim();
    if (!trimmed) {
      connectionId ||= crypto.randomUUID();
      report({ status: 'disconnected' });
      connectionId = '';
      state.value = { status: 'disconnected' };
      return Promise.resolve();
    }
    connectionId = crypto.randomUUID();
    state.value = { status: 'loading' };
    report(state.value);
    return fetchVersion(trimmed, generation);
  }

  watch(
    healthUrl,
    (url) => {
      void connect(url);
    },
    { immediate: true },
  );

  async function refresh(): Promise<void> {
    await connect(healthUrl.value);
  }

  onScopeDispose(() => {
    invalidate();
    report({ status: 'disconnected' });
    connectionId = '';
  });

  return { state: readonly(state), refresh };
}
