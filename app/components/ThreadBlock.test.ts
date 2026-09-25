import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';

import ThreadBlock from './ThreadBlock.vue';
import { useMessages } from '../composables/useMessages';
import type { MessageInfo } from '../types/sse';
import { makeAssistantMessage, makeTextPart, makeUserMessage } from './historyTestBuilders';
import { normalizeCodexTurnsToHistory } from '../backends/codex/normalize';

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
    backendKind?: 'codex' | 'opencode' | 'acp' | 'kimi-web';
    isLatestRoot?: boolean;
    kimiCardActionsReady?: boolean;
    kimiForkAvailable?: boolean;
    kimiUndoAvailable?: boolean;
    cardActionsDisabled?: boolean;
    loadMessageDiffs?: () => Promise<[]>;
    hasMessageDiffs?: () => Promise<boolean>;
    kimiTurnPermissionForUser?: (sessionId: string, userMessageId: string) => string | undefined;
    onCardNotice?: (message: string) => void;
  },
  onShowThreadHistory: (payload: { entries: unknown[] }) => void,
) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(ThreadBlock, {
            root: props.root,
            theme: 'github-dark',
            filesWithBasenames: [],
            isRevertedPreview: false,
            currentSessionId: props.currentSessionId,
            backendKind: props.backendKind,
            isLatestRoot: props.isLatestRoot,
            kimiCardActionsReady: props.kimiCardActionsReady,
            kimiForkAvailable: props.kimiForkAvailable,
            kimiUndoAvailable: props.kimiUndoAvailable,
            cardActionsDisabled: props.cardActionsDisabled,
            loadMessageDiffs: props.loadMessageDiffs,
            hasMessageDiffs: props.hasMessageDiffs,
            kimiTurnPermissionForUser: props.kimiTurnPermissionForUser,
            onCardNotice: props.onCardNotice,
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
  it.each([
    { kind: 'tool', item: { id: 'tool', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: 'files' } },
    { kind: 'reasoning', item: { id: 'reasoning', type: 'reasoning', summary: ['Inspecting the repository'] } },
  ])('opens leading userless $kind history without an assistant text reply', async ({ kind, item }) => {
    const history = normalizeCodexTurnsToHistory({
      sessionId: 'main',
      turns: [{ id: 'leading', createdAt: 100, items: [item] }],
    });
    const store = useMessages();
    store.loadHistory(history);
    const root = store.roots.value[0];
    if (!root) throw new Error('Expected the original assistant root');
    expect(root.role).toBe('assistant');
    expect(store.hasTextContent(root.id)).toBe(false);
    const onShowThreadHistory = vi.fn();
    const view = mount({ root, currentSessionId: 'main', backendKind: 'codex' }, onShowThreadHistory);
    await flushRender();

    expect(view.root.querySelector('.ib-msg-user')).toBeNull();
    expect(view.root.querySelector('.message-viewer-context-assistant')).toBeNull();
    const button = view.root.querySelector<HTMLButtonElement>('.ib-action-history');
    expect(button).not.toBeNull();
    button?.click();
    expect(onShowThreadHistory).toHaveBeenCalledWith({
      entries: [expect.objectContaining({ kind, part: expect.objectContaining({ id: item.id }) })],
    });
  });

  it('hides unsupported checkpoint actions on ACP history cards', async () => {
    const user = makeUserMessage('acp-session', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const view = mount(
      { root: user, currentSessionId: 'acp-session', backendKind: 'acp', isLatestRoot: true },
      vi.fn(),
    );
    await flushRender();
    expect(view.root.querySelector('.ib-top-right')).toBeNull();
    expect(view.root.querySelector('.ib-footer .ib-action-danger')).toBeNull();
  });

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

  it('hides Kimi checkpoint actions until the adapter is ready', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const view = mount({ root: user, currentSessionId: 'main', backendKind: 'kimi-web' }, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-top-right')).toBeNull();
    expect(view.root.querySelector('.ib-footer .ib-action-danger')).toBeNull();
  });

  it('hides Kimi checkpoint mutations until fork and undo probes pass', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const view = mount({ root: user, backendKind: 'kimi-web', kimiCardActionsReady: true }, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-top-right')).toBeNull();
    expect(view.root.querySelector('.ib-action-danger')).toBeNull();
  });

  it('shows checkpoint actions when ready and disables them during a turn', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const view = mount({ root: user, backendKind: 'kimi-web', kimiCardActionsReady: true, kimiForkAvailable: true, kimiUndoAvailable: true, cardActionsDisabled: true, loadMessageDiffs: async () => [], hasMessageDiffs: async () => true }, vi.fn());
    await flushRender();
    expect(view.root.querySelector<HTMLButtonElement>('.ib-top-right')?.disabled).toBe(true);
    expect(view.root.querySelector<HTMLButtonElement>('.ib-action-danger')?.disabled).toBe(true);
    expect(view.root.querySelector<HTMLButtonElement>('.ib-action-diff')?.disabled).toBe(true);
  });

  it('hides the diff action when a turn has no file changes', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const loader = vi.fn<() => Promise<[]>>().mockResolvedValue([]);
    const availability = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const view = mount({ root: user, backendKind: 'kimi-web', loadMessageDiffs: loader, hasMessageDiffs: availability }, vi.fn());
    await flushRender();
    expect(availability).toHaveBeenCalledWith('main', 'u1');
    expect(view.root.querySelector('.ib-action-diff')).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('shows newly recorded Kimi file differences when a queued prompt replaces the latest root', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    let hasDiffs = false;
    const availability = vi.fn(async () => hasDiffs);
    const props = reactive({
      root: user,
      backendKind: 'kimi-web' as const,
      isLatestRoot: true,
      cardActionsDisabled: true,
      hasMessageDiffs: availability,
    });
    const view = mount(props, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-action-diff')).toBeNull();

    props.isLatestRoot = false;
    await flushRender();
    expect(availability).toHaveBeenCalledTimes(1);

    hasDiffs = true;
    useMessages().loadHistory([
      { info: user, parts: [] },
      { info: makeAssistantMessage('main', 'a1', 'u1', 2), parts: [makeTextPart('a1', 'main', 'File updated')] },
    ]);
    props.cardActionsDisabled = false;
    await flushRender();
    expect(availability).toHaveBeenCalledTimes(2);
    expect(view.root.querySelector('.ib-action-diff')).not.toBeNull();
  });

  it('does not refresh historical Kimi cards when another turn completes', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    useMessages().loadHistory([{ info: user, parts: [] }]);
    const availability = vi.fn(async () => false);
    const props = reactive({
      root: user,
      backendKind: 'kimi-web' as const,
      isLatestRoot: false,
      cardActionsDisabled: true,
      hasMessageDiffs: availability,
    });
    const view = mount(props, vi.fn());
    await flushRender();
    props.cardActionsDisabled = false;
    await flushRender();
    expect(availability).toHaveBeenCalledTimes(1);
    expect(view.root.querySelector('.ib-action-diff')).toBeNull();
  });

  it('shows the Kimi permission mode and per-turn tokens under the card', async () => {
    const user = { ...makeUserMessage('main', 'u1', 1), agent: 'main' } as MessageInfo;
    const assistant = { ...makeAssistantMessage('main', 'a1', 'u1', 2, 'main'), mode: 'yolo', tokens: { input: 382, output: 266, reasoning: 0, cache: { read: 0, write: 0 } } } as MessageInfo;
    useMessages().loadHistory([{ info: user, parts: [] }, { info: assistant, parts: [makeTextPart('a1', 'main', 'Done')] }]);
    const view = mount({ root: user, backendKind: 'kimi-web', kimiTurnPermissionForUser: () => undefined }, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-target-agent')?.textContent?.trim()).toBe('yolo');
    expect(view.root.querySelector('.ib-meta-tokens')?.textContent?.replace(/\s/g, '')).toContain('3822660');
  });

  it('uses the accepted turn permission across live and reloaded cards', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    const assistant = { ...makeAssistantMessage('main', 'a1', 'u1', 2), mode: 'manual' } as MessageInfo;
    useMessages().loadHistory([{ info: user, parts: [] }, { info: assistant, parts: [makeTextPart('a1', 'main', 'Done')] }]);
    const perTurn = vi.fn(() => 'yolo');
    const view = mount({ root: user, backendKind: 'kimi-web', kimiTurnPermissionForUser: perTurn }, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-target-agent')?.textContent?.trim()).toBe('yolo');
    expect(perTurn).toHaveBeenCalledWith('main', 'u1');
  });

  it('does not borrow the current Kimi permission for a past card without an attributed mode', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    const assistant = { ...makeAssistantMessage('main', 'a1', 'u1', 2), mode: '' } as MessageInfo;
    useMessages().loadHistory([{ info: user, parts: [] }, { info: assistant, parts: [makeTextPart('a1', 'main', 'Done')] }]);
    const view = mount({ root: user, backendKind: 'kimi-web', kimiTurnPermissionForUser: () => undefined }, vi.fn());
    await flushRender();
    expect(view.root.querySelector('.ib-target-agent')).toBeNull();
  });

  it('keeps the assistant card mounted when a later reply replaces the displayed answer', async () => {
    const user = makeUserMessage('main', 'u1', 1);
    const first = { info: makeAssistantMessage('main', 'a1', 'u1', 2), parts: [makeTextPart('a1', 'main', 'First reply')] };
    useMessages().loadHistory([{ info: user, parts: [] }, first]);
    const view = mount({ root: user, currentSessionId: 'main' }, vi.fn());
    await flushRender();
    const card = view.root.querySelector('.ib-msg-assistant');
    expect(card).not.toBeNull();

    useMessages().loadHistory([
      { info: user, parts: [] }, first,
      { info: makeAssistantMessage('main', 'a2', 'u1', 3), parts: [makeTextPart('a2', 'main', 'Final reply')] },
    ]);
    await flushRender();

    expect(view.root.querySelector('.ib-msg-assistant')).toBe(card);
    expect(card?.classList.contains('ib-fade-leave-active')).toBe(false);
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
