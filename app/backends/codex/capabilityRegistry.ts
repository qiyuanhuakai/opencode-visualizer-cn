import { shallowRef } from 'vue';
import { CodexJsonRpcError } from './jsonRpcClient';

export type CodexCapabilityState = 'unknown' | 'supported' | 'unsupported' | 'gated';

function classifyCapabilityError(error: unknown): CodexCapabilityState {
  if (!(error instanceof CodexJsonRpcError)) return 'unknown';
  if (error.code === -32601) return 'unsupported';
  if (
    error.code === -32600 &&
    /(experimental|capabilit(?:y|ies).*(?:required|disabled)|enable.*feature)/iu.test(error.message)
  ) {
    return 'gated';
  }
  return 'unknown';
}

export function createCodexCapabilityRegistry() {
  const states = shallowRef<Record<string, CodexCapabilityState>>({});
  let generation = 0;

  function set(method: string, state: CodexCapabilityState, requestGeneration = generation) {
    if (requestGeneration !== generation) return;
    states.value = { ...states.value, [method]: state };
  }

  function reset() {
    generation += 1;
    states.value = {};
  }

  async function run<T>(method: string, operation: () => Promise<T>) {
    const requestGeneration = generation;
    try {
      const result = await operation();
      set(method, 'supported', requestGeneration);
      return result;
    } catch (error) {
      set(method, classifyCapabilityError(error), requestGeneration);
      throw error;
    }
  }

  function markSupported(method: string) {
    set(method, 'supported');
  }

  return { states, reset, run, markSupported };
}
