import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { ref } from 'vue';

import SubagentHistoryContent from './SubagentHistoryContent.vue';
import { FLOATING_WINDOW_KEY } from '../composables/useFloatingWindow';
import { useMessages } from '../composables/useMessages';
import type { MessageInfo, ToolPart } from '../types/sse';

function createMessages() {
  return {
    en: {
      toolTitles: {
        shell: 'SHELL',
        write: 'WRITE',
        edit: 'EDIT',
        patch: 'PATCH',
      },
      toolStatus: {
        completed: 'completed',
      },
      threadHistory: {
        thinking: 'Thinking',
        delegation: 'Delegation',
        question: 'Question',
        subagent: 'Subagent',
      },
      subagentHistory: {
        title: 'Subagent',
        close: 'Close',
        empty: 'No subagent history available yet.',
      },
      questionStatus: {
        replied: 'replied',
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
): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'assistant',
    parentID: parentId,
    time: { created: time, completed: time + 10 },
    agent: 'subagent',
    modelID: 'codex',
    providerID: 'codex',
    mode: 'codex',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function makeTextPart(messageId: string, sessionId: string, text: string) {
  return {
    id: `text-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text' as const,
    text,
  };
}

function makeToolPart(messageId: string, sessionId: string, tool: string): ToolPart {
  return {
    id: `tool-${messageId}`,
    callID: `call-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool',
    tool,
    state: {
      status: 'completed',
      input: { command: 'ls' },
      output: 'done',
      title: tool,
      metadata: {},
      time: { start: 1, end: 1 },
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

function makeFloatingWindowStub() {
  return {
    key: 'test-subagent-window',
    content: ref(''),
    html: ref(''),
    title: ref(''),
    status: ref('completed'),
    notifyContentChange: () => {},
    setContent: () => {},
    appendContent: () => {},
    setTitle: () => {},
    setStatus: () => {},
    setColor: () => {},
    bringToFront: () => {},
    minimize: () => {},
    close: () => {},
    onResize: () => {},
  };
}

function mount(props: { parentThreadId: string; sessionLabel?: string; theme?: string }) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const closeSpy = vi.fn();
  // Cast to any to avoid Vue's strict component instance type narrowing in tests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Child = SubagentHistoryContent as any;
  const app = createApp(defineComponent({
    setup() {
      return () => h(Child, {
        ...props,
        onClose: closeSpy,
      });
    },
  }));
  const i18n = createI18n({ legacy: false, locale: 'en', messages: createMessages() });
  app.use(i18n);
  app.provide(FLOATING_WINDOW_KEY, makeFloatingWindowStub());
  app.mount(root);
  return { root, app, closeSpy };
}

describe('SubagentHistoryContent', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    useMessages().reset();
  });

  it('renders the subagent thread id in the header', async () => {
    useMessages().loadHistory([
      {
        info: makeUserMessage('sub-session-1', 'user-1', 1),
        parts: [makeTextPart('user-1', 'sub-session-1', 'Hello from subagent')],
      },
      {
        info: makeAssistantMessage('sub-session-1', 'asst-1', 'user-1', 2),
        parts: [makeTextPart('asst-1', 'sub-session-1', 'Reply from subagent')],
      },
    ]);
    await flushRender();

    const { root, app } = mount({ parentThreadId: 'sub-session-1', sessionLabel: 'My Subagent' });
    await flushRender();

    expect(root.textContent).toContain('My Subagent');
    expect(root.textContent).toContain('Subagent');

    app.unmount();
    root.remove();
  });

  it('falls back to parentThreadId when no sessionLabel is provided', async () => {
    useMessages().loadHistory([
      {
        info: makeUserMessage('fallback-session', 'u1', 1),
        parts: [makeTextPart('u1', 'fallback-session', 'Hi')],
      },
      {
        info: makeAssistantMessage('fallback-session', 'a1', 'u1', 2),
        parts: [makeTextPart('a1', 'fallback-session', 'Hello')],
      },
    ]);
    await flushRender();

    const { root, app } = mount({ parentThreadId: 'fallback-session' });
    await flushRender();

    expect(root.textContent).toContain('fallback-session');

    app.unmount();
    root.remove();
  });

  it('exposes a close button and emits the close event when clicked', async () => {
    useMessages().loadHistory([
      {
        info: makeUserMessage('close-session', 'u1', 1),
        parts: [makeTextPart('u1', 'close-session', 'Hi')],
      },
      {
        info: makeAssistantMessage('close-session', 'a1', 'u1', 2),
        parts: [makeTextPart('a1', 'close-session', 'Hello')],
      },
    ]);
    await flushRender();

    const { root, app, closeSpy } = mount({ parentThreadId: 'close-session' });
    await flushRender();

    const closeButton = root.querySelector('button.subagent-close-button') as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
    expect(closeButton?.textContent?.trim()).toBe('Close');

    closeButton?.click();
    await flushRender();
    expect(closeSpy).toHaveBeenCalled();

    app.unmount();
    root.remove();
  });

  it('renders the subagent history entries when messages exist', async () => {
    useMessages().loadHistory([
      {
        info: makeUserMessage('hist-session', 'u1', 1),
        parts: [makeTextPart('u1', 'hist-session', 'Run ls')],
      },
      {
        info: makeAssistantMessage('hist-session', 'a1', 'u1', 2),
        parts: [makeToolPart('a1', 'hist-session', 'bash')],
      },
    ]);
    await flushRender();

    const { root, app } = mount({ parentThreadId: 'hist-session', sessionLabel: 'History test' });
    await flushRender();

    expect(root.textContent).toContain('SHELL');
    expect(root.textContent).toContain('History test');
    // The tool entry's summary should include the command (rendered via the
    // existing tool summary path, not the markdown worker)
    expect(root.textContent).toContain('$ ls');

    app.unmount();
    root.remove();
  });

  it('shows the empty state when the session has no messages', async () => {
    const { root, app } = mount({ parentThreadId: 'empty-session', sessionLabel: 'Empty test' });
    await flushRender();

    expect(root.textContent).toContain('No subagent history available yet.');

    app.unmount();
    root.remove();
  });

  it('only includes roots from the matching session', async () => {
    useMessages().loadHistory([
      {
        info: makeUserMessage('target-session', 'u-target', 1),
        parts: [makeTextPart('u-target', 'target-session', 'Target message')],
      },
      {
        info: makeAssistantMessage('target-session', 'a-target', 'u-target', 2),
        parts: [makeTextPart('a-target', 'target-session', 'Target reply')],
      },
      {
        info: makeUserMessage('other-session', 'u-other', 1),
        parts: [makeTextPart('u-other', 'other-session', 'Other message')],
      },
      {
        info: makeAssistantMessage('other-session', 'a-other', 'u-other', 2),
        parts: [makeTextPart('a-other', 'other-session', 'Other reply')],
      },
    ]);
    await flushRender();

    const { root, app } = mount({ parentThreadId: 'target-session' });
    await flushRender();

    // Each assistant text message produces a "message" history item.
    // For the target session we expect one message bubble; for the other
    // session we expect zero. The markdown worker doesn't render in vitest,
    // so we count history items instead of asserting on the rendered text.
    const targetItems = root.querySelectorAll('.history-item');
    // The shell + 1 message entry per session, but only the target session
    // contributes a message because the other session's roots are filtered out.
    const targetMessageItems = Array.from(targetItems).filter((el) => {
      const html = el as HTMLElement;
      return !html.classList.contains('history-item-reasoning') &&
        !html.classList.contains('history-item-question') &&
        !html.classList.contains('history-item-subtask') &&
        !html.classList.contains('history-item-tool');
    });
    expect(targetMessageItems.length).toBe(1);

    app.unmount();
    root.remove();
  });
});
