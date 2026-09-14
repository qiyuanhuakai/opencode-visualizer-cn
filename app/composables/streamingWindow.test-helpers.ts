import type { MessageInfo } from '../types/sse';
import type { SessionScope } from './useGlobalEvents';

type Listener = (payload: unknown) => void;

export function createFakeSessionScope() {
  const listeners = new Map<string, Set<Listener>>();
  let disposed = false;

  const scope: SessionScope = {
    on(event: string, listener: Listener) {
      if (disposed) return () => {};
      const eventListeners = listeners.get(event) ?? new Set<Listener>();
      eventListeners.add(listener);
      listeners.set(event, eventListeners);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        eventListeners.delete(listener);
        if (eventListeners.size === 0) listeners.delete(event);
      };
    },
    dispose() {
      disposed = true;
      listeners.clear();
    },
  };

  return {
    scope,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

export function assistantInfo(sessionID: string, id: string, completed?: number): MessageInfo {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created: 1, ...(completed === undefined ? {} : { completed }) },
    parentID: 'parent-1',
    modelID: 'model-1',
    providerID: 'provider-1',
    mode: 'build',
    agent: 'build',
    path: { cwd: '/', root: '/' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}
