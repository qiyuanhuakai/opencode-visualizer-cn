import { onScopeDispose, readonly, ref, watch, type Ref } from 'vue';

export type ConnectedBridgeVersion =
  | { status: 'disconnected' }
  | { status: 'loading' }
  | { status: 'ready'; version: string }
  | { status: 'unavailable' }
  | { status: 'error' };

const HEALTH_TIMEOUT_MS = 5000;

function parseHealthVersion(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  if (!('ok' in body) || body.ok !== true || !('service' in body) || body.service !== 'vis_bridge') return null;
  return 'version' in body && typeof body.version === 'string' && body.version.trim() !== '' ? body.version : null;
}

export function useConnectedBridgeVersion(healthUrl: Ref<string>) {
  const state = ref<ConnectedBridgeVersion>({ status: 'disconnected' });
  let generation = 0;
  let controller: AbortController | null = null;

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
      if (current === generation) state.value = { status: 'error' };
    }, HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { credentials: 'omit', signal });
      if (signal.aborted || current !== generation) return;
      if (!response.ok) {
        state.value = { status: 'error' };
        return;
      }
      const version = parseHealthVersion(await response.json().catch(() => null));
      if (signal.aborted || current !== generation) return;
      state.value = version === null ? { status: 'unavailable' } : { status: 'ready', version };
    } catch {
      if (signal.aborted || current !== generation) return;
      state.value = { status: 'error' };
    } finally {
      clearTimeout(timer);
    }
  }

  watch(
    healthUrl,
    (url) => {
      invalidate();
      const trimmed = url.trim();
      if (!trimmed) {
        state.value = { status: 'disconnected' };
        return;
      }
      state.value = { status: 'loading' };
      void fetchVersion(trimmed, generation);
    },
    { immediate: true },
  );

  onScopeDispose(invalidate);

  return { state: readonly(state) };
}
