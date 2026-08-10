import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InputPanel from './InputPanel.vue';
import en from '../locales/en';

const settings = vi.hoisted(() => ({
  enterToSend: { value: true, __v_isRef: true },
  textTransformersEnabled: { value: true, __v_isRef: true },
  textTransformers: {
    value: [{ trigger: 'hi', replacement: '你好' }],
    __v_isRef: true,
  },
}));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../composables/useSettings', () => ({ useSettings: () => settings }));

const mountedApps: Array<() => void> = [];

function mountInputPanel() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const message = ref('');
  const send = vi.fn();
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(InputPanel, {
            messageInput: message.value,
            'onUpdate:messageInput': (value: string) => {
              message.value = value;
            },
            onSend: send,
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
          });
      },
    }),
  );
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  mountedApps.push(() => {
    app.unmount();
    root.remove();
  });
  return { root, message, send };
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  textarea.setSelectionRange(value.length, value.length);
}

function press(textarea: HTMLTextAreaElement, key: string, isComposing = false) {
  textarea.dispatchEvent(
    new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  settings.enterToSend.value = true;
  settings.textTransformersEnabled.value = true;
  settings.textTransformers.value = [{ trigger: 'hi', replacement: '你好' }];
});

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  document.body.innerHTML = '';
});

describe('InputPanel text transformers', () => {
  it('shows configured transformer completions for a backslash prefix', async () => {
    // Given: transformer completion is enabled.
    const { root } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;

    // When: the user types a matching prefix.
    await typeInto(textarea, String.raw`\h`);
    await nextTick();

    // Then: the popup shows both the sequence and its replacement.
    expect(document.body.textContent).toContain(String.raw`\hi`);
    expect(document.body.textContent).toContain('你好');
    expect(textarea.getAttribute('role')).toBe('combobox');
    expect(textarea.getAttribute('aria-autocomplete')).toBe('list');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(textarea.getAttribute('aria-controls')).toBe('input-mention-listbox');
    expect(textarea.getAttribute('aria-activedescendant')).toBe('input-mention-option-0');
    expect(document.querySelector('#input-mention-listbox')?.getAttribute('role')).toBe('listbox');
    expect(document.querySelector('#input-mention-option-0')?.getAttribute('role')).toBe('option');
    expect(document.querySelector('#input-mention-option-0')?.getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('does not expand or send while an IME composition is active', async () => {
    // Given: a CJK input method is composing text that matches a configured sequence.
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\hi`);

    // When: the IME uses Enter to commit its current composition.
    press(textarea, 'Enter', true);
    await nextTick();

    // Then: the composer leaves the text and send state untouched.
    expect(message.value).toBe(String.raw`\hi`);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([' ', 'Tab'])('expands an exact sequence when %s is pressed', async (key) => {
    // Given: the cursor follows an exact configured sequence.
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`Before \hi`);

    // When: Space or Tab triggers expansion.
    press(textarea, key);
    await nextTick();

    // Then: the sequence is replaced in place and a trailing space is inserted.
    expect(message.value).toBe('Before 你好 ');
    expect(textarea.selectionStart).toBe('Before 你好 '.length);
  });

  it('accepts a partial transformer completion with Tab', async () => {
    // Given: the popup offers a configured mapping for a partial sequence.
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\h`);
    await nextTick();

    // When: Tab accepts the highlighted completion.
    press(textarea, 'Tab');
    await nextTick();

    // Then: the entire partial token is replaced by the configured content.
    expect(message.value).toBe('你好 ');
  });

  it.each(['Tab', 'Enter'])(
    'prefers the highlighted completion over an exact shorter trigger with %s',
    async (key) => {
      // Given: an exact short trigger and a longer completion both match the current input.
      settings.textTransformers.value = [
        { trigger: 'foo', replacement: 'short' },
        { trigger: 'foobar', replacement: 'long' },
      ];
      const { root, message, send } = mountInputPanel();
      const textarea = root.querySelector('textarea')!;
      await typeInto(textarea, String.raw`\foo`);
      await nextTick();
      press(textarea, 'ArrowDown');

      // When: the delimiter accepts the highlighted longer completion.
      press(textarea, key);
      await nextTick();

      // Then: the highlighted mapping wins without sending the message.
      expect(message.value).toBe('long ');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('expands on Enter before a subsequent Enter sends', async () => {
    // Given: Enter-to-send is enabled and the input ends with an exact sequence.
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\hi`);

    // When: Enter is pressed twice.
    press(textarea, 'Enter');
    await nextTick();
    press(textarea, 'Enter');
    await nextTick();

    // Then: the first press expands without sending and the second sends the expanded prompt.
    expect(message.value).toBe('你好 ');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('preserves unknown sequences and bypasses all behavior when disabled', async () => {
    // Given: the configured transformer feature is disabled.
    settings.textTransformersEnabled.value = false;
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\hi`);

    // When: Enter is pressed.
    press(textarea, 'Enter');
    await nextTick();

    // Then: no popup or replacement occurs and the original input is sent unchanged.
    expect(message.value).toBe(String.raw`\hi`);
    expect(document.body.textContent).not.toContain('你好');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
