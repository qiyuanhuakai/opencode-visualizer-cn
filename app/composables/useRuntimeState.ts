import { computed, getCurrentScope, onScopeDispose, shallowRef } from 'vue';
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { createRuntimeState } from '../runtime/state';
import type { RuntimePageView, RuntimeStateOptions } from '../runtime/state';

export function useRuntimeState(options: RuntimeStateOptions) {
  const state = createRuntimeState(options);
  const page = shallowRef<RuntimePageView | null>(null);
  const selection = shallowRef(state.capture());
  const usage = shallowRef(state.usage());
  const failure = shallowRef<ErrorCode | null>(null);
  let disposed = false;
  const unsubscribe = state.subscribe(() => {
    if (disposed) return;
    const next = state.view('session_summaries');
    const old = page.value; page.value = next; old?.release();
    selection.value = state.capture(); usage.value = state.usage();
  });
  async function dispose() {
    if (!disposed) { disposed = true; unsubscribe(); page.value?.release(); page.value = null; selection.value = null; }
    await state.dispose(); usage.value = state.usage();
  }
  if (getCurrentScope()) onScopeDispose(() => { void dispose().catch(error => { failure.value = error instanceof ProtocolError ? error.code : 'source_unavailable'; }); });
  return {
    start: state.start, select: state.select, retry: state.retry, dispose,
    page: computed(() => page.value), selection: computed(() => selection.value),
    usage: computed(() => usage.value), failure: computed(() => failure.value),
  };
}
