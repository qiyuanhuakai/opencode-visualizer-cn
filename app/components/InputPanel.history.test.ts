import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InputPanel from './InputPanel.vue';
import { useMessages } from '../composables/useMessages';
import en from '../locales/en';
import type { MessageInfo, TextPart } from '../types/sse';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../composables/useSettings', () => ({
  useSettings: () => ({ enterToSend: { value: true, __v_isRef: true } }),
}));

const mountedApps: Array<() => void> = [];

function userMessage(id: string, sessionID: string, text: string, synthetic = false) {
  const info: MessageInfo = {
    id,
    sessionID,
    role: 'user',
    time: { created: Number(id.replace(/\D/gu, '')) || 1 },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt' },
  };
  const part: TextPart = {
    id: `${id}:text`,
    sessionID,
    messageID: id,
    type: 'text',
    text,
    synthetic,
  };
  return { info, parts: [part] };
}

function mountInputPanel() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(InputPanel, {
            messageInput: '',
            canSend: true,
            selectedMode: 'build',
            agentOptions: [{ id: 'build', label: 'Build' }],
            hasAgentOptions: true,
            selectedModel: 'openai/gpt',
            selectedThinking: undefined,
            modelOptions: [
              {
                id: 'openai/gpt',
                modelID: 'gpt',
                label: 'GPT',
                displayName: 'GPT',
                providerID: 'openai',
              },
            ],
            thinkingOptions: [undefined],
            hasModelOptions: true,
            hasThinkingOptions: true,
            isThinking: false,
            canAbort: false,
            commands: [],
            attachments: [],
            currentSessionId: 'root',
            sessionParentById: new Map<string, string | undefined>([
              ['root', undefined],
              ['child', 'root'],
            ]),
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  app.mount(root);
  mountedApps.push(() => {
    app.unmount();
    root.remove();
  });
  return root;
}

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  useMessages().reset();
  document.body.innerHTML = '';
});

describe('InputPanel prompt history', () => {
  it('shows only non-synthetic user input from root sessions', async () => {
    const messages = useMessages();
    messages.reset();
    messages.loadHistory([
      userMessage('user-1', 'root', 'real user prompt'),
      userMessage('user-2', 'root', 'system injected prompt', true),
      userMessage('user-3', 'child', 'subagent prompt'),
      userMessage(
        'user-4',
        'root',
        '<system-reminder>\n[BACKGROUND TASK COMPLETED]\ninternal reminder',
      ),
      userMessage(
        'user-5',
        'root',
        'visible before reminder<system-reminder>\ninternal appended reminder',
      ),
    ]);
    const root = mountInputPanel();

    root
      .querySelector('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await nextTick();

    expect(document.body.textContent).toContain('real user prompt');
    expect(document.body.textContent).not.toContain('system injected prompt');
    expect(document.body.textContent).not.toContain('subagent prompt');
    expect(document.body.textContent).not.toContain('internal reminder');
    expect(document.body.textContent).toContain('visible before reminder');
    expect(document.body.textContent).not.toContain('internal appended reminder');
  });
});
