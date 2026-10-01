import { createApp, defineComponent, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessagePart } from '../types/sse';
import { useFloatingWindows } from './useFloatingWindows';
import type { SessionScope } from './useGlobalEvents';
import { useReasoningWindows } from './useReasoningWindows';
import { assistantInfo, createFakeSessionScope } from './streamingWindow.test-helpers';

vi.mock('../i18n/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const mountedApps: Array<() => void> = [];

function mountReasoningWindows(scope: SessionScope, suppressAutoWindows = ref(false)) {
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
          suppressAutoWindows,
          t: (key: string) => key,
        });
        return () => null;
      },
    }),
  );
  app.mount(root);
  mountedApps.push(() => {
    app.unmount();
    root.remove();
  });
  if (!api) throw new Error('reasoning windows composable did not mount');
  return api;
}

describe('useReasoningWindows message-level completion', () => {
  it('discards suppressed reasoning instead of retaining a hidden backlog', () => {
    const fake = createFakeSessionScope();
    const suppressed = ref(true);
    const api = mountReasoningWindows(fake.scope, suppressed);
    for (let i = 0; i < 100; i++) api.handlePart({
      id: `hidden-${i}`, sessionID: 'main', messageID: `message-${i}`,
      type: 'reasoning', text: 'hidden reasoning', time: { start: 1 },
    });
    expect(api.entriesBySession.size).toBe(0);
    suppressed.value = false;
    api.handlePart({ id: 'new', sessionID: 'main', messageID: 'new-message',
      type: 'reasoning', text: 'visible reasoning', time: { start: 2 } });
    expect(api.entriesBySession.get('main')?.map((entry) => entry.id)).toEqual(['new']);
  });
  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(async () => {
    while (mountedApps.length > 0) mountedApps.pop()?.();
    document.body.innerHTML = '';
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('removes a fake scope listener when its unsubscribe function runs', () => {
    const fake = createFakeSessionScope();
    let received = 0;
    const unsubscribe = fake.scope.on('message.updated', () => { received += 1; });
    unsubscribe();
    fake.emit('message.updated', { info: assistantInfo('session-1', 'message-1') });
    expect(fake.listenerCount('message.updated')).toBe(0);
    expect(received).toBe(0);
  });

  it('stops receiving scope events after the fake scope is disposed', () => {
    const fake = createFakeSessionScope();
    const api = mountReasoningWindows(fake.scope);
    fake.scope.dispose();
    fake.emit('message.part.updated', { part: {
      id: 'part-1', sessionID: 'session-1', messageID: 'message-1', type: 'reasoning', text: 'thinking…', time: { start: 1 },
    } satisfies MessagePart });
    expect(fake.listenerCount('message.part.updated')).toBe(0);
    expect(api.entriesBySession?.get('session-1')).toBeUndefined();
  });

  it('marks the streaming entry completed when completion arrives at message level without a part-level time.end', () => {
    // Given: a reasoning part still streaming (no part-level time.end)
    const fake = createFakeSessionScope();
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
    const fake = createFakeSessionScope();
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
