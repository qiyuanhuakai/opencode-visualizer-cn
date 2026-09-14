import { createApp, defineComponent, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessagePart } from '../types/sse';
import { useFloatingWindows } from './useFloatingWindows';
import type { SessionScope } from './useGlobalEvents';
import { useSubagentWindows } from './useSubagentWindows';
import { assistantInfo, createFakeSessionScope } from './streamingWindow.test-helpers';

vi.mock('../i18n/useI18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const mountedApps: Array<() => void> = [];

function mountSubagentWindows(scope: SessionScope) {
  const selectedSessionId = ref('main');
  let api: ReturnType<typeof useSubagentWindows> | undefined;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        api = useSubagentWindows({
          scope,
          selectedSessionId,
          fw: useFloatingWindows(),
          subagentComponent: defineComponent(() => () => null),
          theme: () => 'light',
          closeDelayMs: 60000,
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
  if (!api) throw new Error('subagent windows composable did not mount');
  return api;
}

describe('useSubagentWindows message-level completion', () => {
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
    const api = mountSubagentWindows(fake.scope);
    fake.scope.dispose();
    fake.emit('message.part.updated', { part: {
      id: 'part-1', sessionID: 'session-1', messageID: 'message-1', type: 'text', text: 'working…', time: { start: 1 },
    } satisfies MessagePart });
    expect(fake.listenerCount('message.part.updated')).toBe(0);
    expect(api.entriesBySession?.get('session-1')).toBeUndefined();
  });

  it('marks the streaming entry completed when completion arrives at message level without a part-level time.end', () => {
    // Given: a subagent text part still streaming (no part-level time.end)
    const fake = createFakeSessionScope();
    const api = mountSubagentWindows(fake.scope);
    const part: MessagePart = {
      id: 'part-1',
      sessionID: 'session-1',
      messageID: 'message-1',
      type: 'text',
      text: 'working…',
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
});
