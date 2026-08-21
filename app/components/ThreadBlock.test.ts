import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

import ThreadBlock from './ThreadBlock.vue';
import { useMessages } from '../composables/useMessages';
import type { MessageInfo, MessagePart } from '../types/sse';

const workerState = vi.hoisted(() => {
  class FakeWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    postMessage(_message: unknown) {}
    terminate() {}
  }
  return { FakeWorker };
});

vi.mock('../workers/render-worker?worker', () => ({ default: workerState.FakeWorker }));

function createMessages() {
  return {
    en: {
      threadBlock: {
        confirmFork: 'Fork from this message?',
        confirmRevert: 'Revert to this message?',
        confirmUndoRevert: 'Undo revert?',
        historyTitle: '{count} entries - click to view history',
        historyLabel: 'History',
        fork: 'FORK',
        undo: 'UNDO',
        viewSubagent: 'View subagent',
        viewSubagentTitle: 'Open subagent history for {sessionId}',
      },
    },
  };
}

function makeUserMessage(sessionId: string, id: string, time: number): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'user',
    time: { created: time },
    agent: 'build',
    model: { providerID: 'test', modelID: 'test-model' },
  };
}

function makeAssistantMessage(
  sessionId: string,
  id: string,
  parentId: string,
  time: number,
  agent: string,
): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'assistant',
    parentID: parentId,
    time: { created: time, completed: time + 10 },
    agent,
    modelID: 'codex',
    providerID: 'codex',
    mode: 'codex',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function makeTextPart(messageId: string, sessionId: string, text: string): MessagePart {
  return {
    id: `text-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function mount(
  props: {
    root: MessageInfo;
    currentSessionId?: string;
  },
  onShowThreadHistory: (payload: { entries: unknown[] }) => void,
) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  // Cast to any to avoid Vue's strict component instance type narrowing in tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Child = ThreadBlock as any;
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(Child, {
            root: props.root,
            theme: 'github-dark',
            filesWithBasenames: [],
            isRevertedPreview: false,
            currentSessionId: props.currentSessionId,
            deferredTransitionKey: 'test',
            onShowThreadHistory,
          });
      },
    }),
  );
  const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
  app.use(i18n);
  app.mount(root);
  return { root, app };
}

describe('ThreadBlock history wiring', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useMessages().reset();
  });

  it('Given a thread with a subagent-session assistant message, When the history button is clicked, Then the emitted entry carries isSubagent true and the agent name', async () => {
    const userMessage = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([
      {
        info: userMessage,
        parts: [makeTextPart('u1', 'main', 'prompt')],
      },
      {
        info: makeAssistantMessage('sub-session', 'a1', 'u1', 2, 'codex'),
        parts: [makeTextPart('a1', 'sub-session', 'reply')],
      },
    ]);
    await flushRender();
    const onShowThreadHistory = vi.fn();
    const { root, app } = mount(
      { root: userMessage, currentSessionId: 'main' },
      onShowThreadHistory,
    );
    await flushRender();

    const button = root.querySelector<HTMLElement>('button.ib-action-history');
    expect(button).not.toBeNull();
    button?.click();
    await flushRender();

    expect(onShowThreadHistory).toHaveBeenCalledTimes(1);
    const payload = onShowThreadHistory.mock.calls[0][0] as {
      entries: Array<Record<string, unknown>>;
    };
    const messageEntry = payload.entries.find((entry) => entry.kind === 'message');
    expect(messageEntry).toMatchObject({
      isSubagent: true,
      agent: 'codex',
      sessionId: 'sub-session',
      content: 'reply',
    });

    app.unmount();
    root.remove();
  });

  it('Given a thread with a same-session assistant message, When the history button is clicked, Then the emitted entry carries isSubagent false', async () => {
    const userMessage = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([
      {
        info: userMessage,
        parts: [makeTextPart('u1', 'main', 'prompt')],
      },
      {
        info: makeAssistantMessage('main', 'a1', 'u1', 2, 'build'),
        parts: [makeTextPart('a1', 'main', 'reply')],
      },
    ]);
    await flushRender();
    const onShowThreadHistory = vi.fn();
    const { root, app } = mount(
      { root: userMessage, currentSessionId: 'main' },
      onShowThreadHistory,
    );
    await flushRender();

    root.querySelector<HTMLElement>('button.ib-action-history')?.click();
    await flushRender();

    expect(onShowThreadHistory).toHaveBeenCalledTimes(1);
    const payload = onShowThreadHistory.mock.calls[0][0] as {
      entries: Array<Record<string, unknown>>;
    };
    const messageEntry = payload.entries.find((entry) => entry.kind === 'message');
    expect(messageEntry).toMatchObject({ isSubagent: false, agent: 'build' });

    app.unmount();
    root.remove();
  });
});
