import { createApp, defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';

import type { MessageInfo, MessagePart } from '../types/sse';
import { useFloatingWindows } from './useFloatingWindows';
import type { SessionScope } from './useGlobalEvents';
import { useReasoningWindows } from './useReasoningWindows';

function createFakeScope() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const scope: SessionScope = {
    on(event: string, listener: (payload: unknown) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return () => {};
    },
    dispose() {},
  };
  return {
    scope,
    emit(event: string, payload: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

function assistantInfo(sessionID: string, id: string, completed?: number): MessageInfo {
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

const mountedApps: Array<() => void> = [];

function mountReasoningWindows(scope: SessionScope) {
  const selectedSessionId = ref('main');
  let api: ReturnType<typeof useReasoningWindows> | undefined;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        api = useReasoningWindows({
          scope,
          selectedSessionId,
          fw: useFloatingWindows(),
          reasoningComponent: defineComponent(() => () => null),
          theme: () => 'light',
          reasoningCloseDelayMs: 60000,
          t: (key: string) => key,
        });
        return () => null;
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(root);
  mountedApps.push(() => {
    app.unmount();
    root.remove();
  });
  if (!api) throw new Error('reasoning windows composable did not mount');
  return api;
}

describe('useReasoningWindows message-level completion', () => {
  afterEach(() => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    document.body.innerHTML = '';
  });

  it('marks the streaming entry completed when completion arrives at message level without a part-level time.end', () => {
    // Given: a reasoning part still streaming (no part-level time.end)
    const fake = createFakeScope();
    const api = mountReasoningWindows(fake.scope);
    const part: MessagePart = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'thinking…',
      time: { start: 1 },
    };
    fake.emit('message.part.updated', { part });
    expect(api.entriesBySession?.get('session-1')?.[0]?.completed).toBe(false);

    // When: completion arrives at message level (time.completed)
    fake.emit('message.updated', {
      info: assistantInfo('session-1', 'message-1', 2),
    });

    // Then: the entry flips to completed so the window can converge before close
    expect(api.entriesBySession?.get('session-1')?.[0]?.completed).toBe(true);
  });

  it('marks the streaming entry completed when an error arrives at message level', () => {
    // Given: a reasoning part still streaming
    const fake = createFakeScope();
    const api = mountReasoningWindows(fake.scope);
    const part: MessagePart = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'reasoning',
      text: 'thinking…',
      time: { start: 1 },
    };
    fake.emit('message.part.updated', { part });

    // When: the message errors without a part-level time.end
    const info = assistantInfo('session-1', 'message-1');
    fake.emit('message.updated', {
      info: { ...info, error: { name: 'MessageAbortedError', data: { message: 'boom' } } },
    });

    // Then: the entry flips to completed
    expect(api.entriesBySession?.get('session-1')?.[0]?.completed).toBe(true);
  });
});
