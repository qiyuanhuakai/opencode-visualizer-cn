import { createApp, defineComponent, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InputPanel from './InputPanel.vue';
import { useMessages } from '../composables/useMessages';
import { useFavoriteMessages } from '../composables/useFavoriteMessages';
import en from '../locales/en';
import type { MessageInfo, TextPart } from '../types/sse';
import type { TextTransformer } from '../utils/textTransformers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const settings = vi.hoisted(() => ({
  enterToSend: { value: true, __v_isRef: true },
  textTransformersEnabled: { value: false, __v_isRef: true },
  textTransformers: { value: [] as TextTransformer[], __v_isRef: true },
}));
vi.mock('../composables/useSettings', () => ({
  useSettings: () => settings,
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
  const openSnippetSettings = vi.fn();
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
            onOpenSnippetSettings: openSnippetSettings,
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
  return { root, openSnippetSettings };
}

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  useMessages().reset();
  useFavoriteMessages().favorites.value = [];
  settings.textTransformers.value = [];
  document.body.innerHTML = '';
});

describe('InputPanel prompt history', () => {
  it('does not mount history rows until the closed dropdown opens', async () => {
    const messages = useMessages();
    messages.loadHistory([
      userMessage('user-1', 'root', 'first prompt'),
      userMessage('user-2', 'root', 'second prompt'),
    ]);

    const { root } = mountInputPanel();
    await nextTick();

    expect(root.querySelectorAll('.history-item')).toHaveLength(0);

    root
      .querySelector('textarea')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await nextTick();

    expect(root.querySelectorAll('.history-item')).toHaveLength(2);
  });

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
        '<system-reminder>\n[BACKGROUND TASK COMPLETED]\ninternal reminder\n</system-reminder>\n<!-- OMO_INTERNAL_NOREPLY -->',
      ),
      userMessage(
        'user-5',
        'root',
        'visible before reminder<system-reminder>\ninternal appended reminder\n</system-reminder>',
      ),
      userMessage('user-6', 'root', 'literal <system-reminder> discussion stays visible'),
      userMessage(
        'user-7',
        'root',
        'balanced <system-reminder>example</system-reminder> with visible suffix',
      ),
    ]);
    const { root } = mountInputPanel();

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
    expect(document.body.textContent).toContain('literal <system-reminder> discussion stays visible');
    expect(document.body.textContent).toContain(
      'balanced <system-reminder>example</system-reminder> with visible suffix',
    );
  });

  it('creates an editable disabled snippet from a favorite and opens snippet settings', async () => {
    // Given: the favorites dropdown contains a multiline prompt and storage has a legacy slash trigger.
    useFavoriteMessages().favorites.value = [
      { text: 'Review this change carefully.\nCheck regressions.' },
    ];
    settings.textTransformers.value = [
      {
        id: 'snippet-existing',
        trigger: '\\favorite',
        name: 'Existing favorite',
        body: 'Existing',
        enabled: true,
        tags: [],
      },
    ];
    const { root, openSnippetSettings } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick();

    // When: the favorite's create-snippet action is clicked.
    const button = root.querySelector<HTMLButtonElement>('.favorite-snippet-action');
    expect(button).not.toBeNull();
    button!.click();
    await nextTick();

    // Then: a safe disabled draft is created and its editor opens immediately.
    expect(settings.textTransformers.value).toEqual([
      expect.objectContaining({ id: 'snippet-existing', trigger: '\\favorite' }),
      {
        id: expect.stringMatching(/^snippet-/),
        trigger: 'favorite-2',
        name: 'Review this change carefully.',
        body: 'Review this change carefully.\nCheck regressions.',
        enabled: false,
        tags: [],
      },
    ]);
    expect(openSnippetSettings).toHaveBeenCalledTimes(1);
    const favoritesDropdown = root.querySelectorAll('.history-dropdown-wrapper .ui-dropdown')[1];
    expect(favoritesDropdown?.classList.contains('is-open')).toBe(false);
    expect(favoritesDropdown?.querySelector('.ui-dropdown-menu')?.hasAttribute('inert')).toBe(true);
  });
});
