import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';

import ThreadBlock from './ThreadBlock.vue';
import { useMessages } from '../composables/useMessages';
import type { MessageInfo } from '../types/sse';
import { makeAssistantMessage, makeTextPart, makeUserMessage } from './historyTestBuilders';

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
vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const mountedApps = new Set<ReturnType<typeof createApp>>();

function unmount(app: ReturnType<typeof createApp>) {
  if (!mountedApps.delete(app)) return;
  app.unmount();
}

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
    backendKind?: 'codex' | 'opencode';
    isLatestRoot?: boolean;
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
            backendKind: props.backendKind,
            isLatestRoot: props.isLatestRoot,
            deferredTransitionKey: 'test',
            onShowThreadHistory,
          });
      },
    }),
  );
  mountedApps.add(app);
  const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
  app.use(i18n);
  app.mount(root);
  return { root, app };
}

describe('ThreadBlock history wiring', () => {
  it.each([false, true])(
    'shows revert on Codex cards while limiting fork to latest=%s',
    async (isLatestRoot) => {
      const user = makeUserMessage('main', 'u1', 1);
      useMessages().loadHistory([{ info: user, parts: [] }]);
      const view = mount(
        { root: user, currentSessionId: 'main', backendKind: 'codex', isLatestRoot },
        vi.fn(),
      );
      await flushRender();
      expect(view.root.querySelector('.ib-footer .ib-action-danger')).not.toBeNull();
      expect(
        [...view.root.querySelectorAll('button')].some(
          (button) => button.textContent?.trim() === 'FORK',
        ),
      ).toBe(isLatestRoot);
      unmount(view.app);
    },
  );
  afterEach(() => {
    mountedApps.forEach(unmount);
    document.body.innerHTML = '';
    useMessages().reset();
  });

  it('shows Codex turn attachments when the latest reply is a separate assistant message', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([
      { info: user, parts: [] },
      {
        info: makeAssistantMessage('main', 'turn-tools', 'u1', 2, 'codex'),
        parts: [
          {
            id: 'image-1',
            sessionID: 'main',
            messageID: 'turn-tools',
            type: 'file',
            mime: 'image/png',
            filename: 'preview.png',
            url: 'data:image/png;base64,AA==',
          },
        ],
      },
      {
        info: makeAssistantMessage('main', 'reply-2', 'u1', 3, 'codex'),
        parts: [makeTextPart('reply-2', 'main', 'Final answer')],
      },
    ]);
    const view = mount({ root: user, currentSessionId: 'main', backendKind: 'codex' }, vi.fn());
    await flushRender();
    expect(view.root.querySelectorAll('.thread-assistant img')).toHaveLength(1);
    expect(view.root.querySelector('img')?.getAttribute('alt')).toBe('preview.png');
    unmount(view.app);
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

    unmount(app);
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

    unmount(app);
    root.remove();
  });
});
