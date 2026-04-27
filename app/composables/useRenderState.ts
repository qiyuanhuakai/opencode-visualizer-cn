import { ref, readonly } from 'vue';

const _pendingWorkerRenders = ref(0);

export const pendingWorkerRenders = readonly(_pendingWorkerRenders);

export function useRenderState() {
  return {
    pendingWorkerRenders,
  };
}

export function incrementPendingRenders(): void {
  _pendingWorkerRenders.value++;
}

export function decrementPendingRenders(): void {
  if (_pendingWorkerRenders.value > 0) {
    _pendingWorkerRenders.value--;
  }
}
