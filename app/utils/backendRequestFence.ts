import type { BackendKind } from '../backends/types';

type BackendRequestToken = {
  backend: BackendKind;
  generation: number;
};

export function createBackendRequestFence(getActiveBackend: () => BackendKind) {
  let generation = 0;

  function start(): BackendRequestToken {
    return {
      backend: getActiveBackend(),
      generation: ++generation,
    };
  }

  function isCurrent(token: BackendRequestToken): boolean {
    return token.generation === generation && token.backend === getActiveBackend();
  }

  function invalidate() {
    generation += 1;
  }

  return { start, isCurrent, invalidate };
}
