import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import InputPanel from './InputPanel.vue';
import en from '../locales/en';

const settings = vi.hoisted(() => ({
  enterToSend: { value: true, __v_isRef: true },
  textTransformersEnabled: { value: true, __v_isRef: true },
  textTransformers: {
    value: [
      {
        id: 'snippet-hi',
        trigger: 'hi',
        name: 'Greeting',
        body: '你好',
        description: 'Friendly greeting',
        enabled: true,
        tags: ['Common'],
      },
    ],
    __v_isRef: true,
  },
}));

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../composables/useSettings', () => ({ useSettings: () => settings }));

const mountedApps: Array<() => void> = [];

function mountInputPanel(options: { commands?: Array<{ name: string; description?: string }> } = {}) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const message = ref('');
  const currentSessionId = ref('session-a');
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
            commands: options.commands ?? [],
            attachments: [],
            currentSessionId: currentSessionId.value,
            activeDirectory: '/repo',
            activeFile: '/repo/src/main.ts',
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
  return { root, message, send, currentSessionId };
}

async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  textarea.setSelectionRange(value.length, value.length);
}

function press(textarea: HTMLTextAreaElement, key: string, isComposing = false) {
  const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
  textarea.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  settings.enterToSend.value = true;
  settings.textTransformersEnabled.value = true;
  settings.textTransformers.value = [
    {
      id: 'snippet-hi',
      trigger: 'hi',
      name: 'Greeting',
      body: '你好',
      description: 'Friendly greeting',
      enabled: true,
      tags: ['Common'],
    },
  ];
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

    // Then: the popup shows the trigger, name, description, and a compact body preview.
    expect(document.body.textContent).toContain(String.raw`\hi`);
    expect(document.body.textContent).toContain('Greeting');
    expect(document.body.textContent).toContain('Friendly greeting');
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

  it('refreshes transformer completions when only the caret position changes', async () => {
    // Given: matching transformer text exists before the caret, but not at the initial caret position.
    const { root } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\hi suffix`);
    expect(textarea.getAttribute('aria-expanded')).toBe('false');

    // When: an arrow key moves the caret into the partial trigger without editing the text.
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    await nextTick();

    // Then: the popup opens for the new caret context and closes after a mouse move leaves it.
    expect(textarea.getAttribute('aria-expanded')).toBe('true');
    expect(document.body.textContent).toContain(String.raw`\hi`);
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
  });

  it('resynchronizes the popup after a programmatic message update', async () => {
    // Given: the mirrored caret points into a trigger before the parent replaces the draft.
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\hi suffix`);
    textarea.setSelectionRange(2, 2);
    textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    await nextTick();
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    // When: the parent updates the draft and Enter is pressed at the DOM caret.
    message.value = String.raw`\h plain`;
    await nextTick();
    await nextTick();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    press(textarea, 'Enter');
    await nextTick();

    // Then: the stale popup does not consume Enter and the unchanged draft is sent.
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    expect(message.value).toBe(String.raw`\h plain`);
    expect(send).toHaveBeenCalledTimes(1);
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

  it('does not consume Space to expand an exact sequence', async () => {
    // Given: the cursor follows an exact configured sequence with its popup open.
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`Before \hi`);

    // When: Space is pressed.
    const event = press(textarea, ' ');
    await nextTick();

    // Then: the transformer leaves the key and draft untouched for native text insertion.
    expect(event.defaultPrevented).toBe(false);
    expect(message.value).toBe(String.raw`Before \hi`);
  });

  it('does not accept a partial transformer completion with Tab', async () => {
    // Given: the popup offers a configured mapping for a partial sequence.
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\h`);
    await nextTick();

    // When: Tab follows the application's existing non-transformer shortcut path.
    press(textarea, 'Tab');
    await nextTick();

    // Then: the transformer does not replace the partial token.
    expect(message.value).toBe(String.raw`\h`);
  });

  it('always sends on Ctrl+Enter while a snippet popup is open', async () => {
    // Given: a matching snippet popup is open over a sendable draft.
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\h`);
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    // When: the user invokes the existing always-send shortcut.
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    await nextTick();

    // Then: the popup cannot consume the shortcut or expand the draft.
    expect(event.defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(message.value).toBe(String.raw`\h`);
  });

  it('keeps built-in command completion ahead of an overlapping snippet', async () => {
    // Given: one command and one custom-prefix snippet match the same slash input.
    settings.textTransformers.value = [
      {
        id: 'snippet-overlap',
        trigger: '::foo',
        name: 'Overlapping snippet',
        body: 'snippet body',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    const { root, message, send } = mountInputPanel({
      commands: [{ name: '::foo', description: 'Built-in command' }],
    });
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, '/::f');
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    // When: Enter accepts the highlighted completion.
    press(textarea, 'Enter');
    await nextTick();

    // Then: the command wins and the snippet body is never inserted.
    expect(message.value).toBe('/::foo ');
    expect(message.value).not.toContain('snippet body');
    expect(send).not.toHaveBeenCalled();
  });

  it('replaces a selected range when the confirmed snippet uses selection context', async () => {
    // Given: the textarea selection follows a matching snippet trigger.
    settings.textTransformers.value = [
      {
        id: 'snippet-wrap',
        trigger: 'wrap',
        name: 'Wrap selection',
        body: '[{selection}]',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    const input = String.raw`Before \wrapselected after`;
    await typeInto(textarea, input);
    const selectionStart = String.raw`Before \wrap`.length;
    const selectionEnd = selectionStart + 'selected'.length;
    textarea.setSelectionRange(selectionStart, selectionEnd);
    textarea.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    await nextTick();
    expect(textarea.getAttribute('aria-expanded')).toBe('true');

    // When: Enter confirms the displayed completion.
    press(textarea, 'Enter');
    await nextTick();

    // Then: the trigger and selected text become one expansion without duplication.
    expect(message.value).toBe('Before [selected]  after');
    expect(textarea.selectionStart).toBe('Before [selected] '.length);
    expect(textarea.selectionEnd).toBe('Before [selected] '.length);
  });

  it('prefers the highlighted completion over an exact shorter trigger with Enter', async () => {
      // Given: an exact short trigger and a longer completion both match the current input.
      settings.textTransformers.value = [
        {
          id: 'snippet-foo',
          trigger: 'foo',
          name: 'Short',
          body: 'short',
          description: '',
          enabled: true,
          tags: [],
        },
        {
          id: 'snippet-foobar',
          trigger: 'foobar',
          name: 'Long',
          body: 'long',
          description: '',
          enabled: true,
          tags: [],
        },
      ];
      const { root, message, send } = mountInputPanel();
      const textarea = root.querySelector('textarea')!;
      await typeInto(textarea, String.raw`\foo`);
      await nextTick();
      press(textarea, 'ArrowDown');

      // When: the delimiter accepts the highlighted longer completion.
      press(textarea, 'Enter');
      await nextTick();

      // Then: the highlighted mapping wins without sending the message.
      expect(message.value).toBe('long ');
      expect(send).not.toHaveBeenCalled();
  });

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

  it('expands multiline custom-prefix snippets with live editor context', async () => {
    // Given: a custom-prefix snippet uses clipboard, file, cwd, and cursor variables.
    settings.textTransformers.value = [
      {
        id: 'snippet-context',
        trigger: '::ctx',
        name: 'Insert context',
        body: '{clipboard}\n{activeFile}\n{cwd}\n{cursor}Continue',
        description: '',
        enabled: true,
        tags: ['Context'],
      },
    ];
    const readText = vi.fn().mockResolvedValue('clipboard text');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText },
    });
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, 'Before ::ct');

    // When: Enter confirms the highlighted snippet.
    press(textarea, 'Enter');

    // Then: context variables resolve and the caret lands before trailing body text.
    await vi.waitFor(() => {
      expect(message.value).toBe(
        'Before clipboard text\n/repo/src/main.ts\n/repo\nContinue ',
      );
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(textarea.selectionStart).toBe('Before clipboard text\n/repo/src/main.ts\n/repo\n'.length);
  });

  it('does not overwrite an ABA-restored draft after asynchronous clipboard resolution', async () => {
    // Given: a confirmed snippet is waiting for an asynchronous clipboard read.
    settings.textTransformers.value = [
      {
        id: 'snippet-clipboard',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    let resolveClipboard!: (value: string) => void;
    const readText = vi.fn(
      () => new Promise<string>((resolve) => (resolveClipboard = resolve)),
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText },
    });
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);
    await nextTick();

    // When: the user confirms, edits away and back to the exact captured draft, then the clipboard resolves.
    press(textarea, 'Enter');
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    await typeInto(textarea, 'newer draft');
    await typeInto(textarea, String.raw`\clip`);
    resolveClipboard('stale clipboard');
    await nextTick();

    // Then: revision identity, not final text equality, rejects the stale expansion.
    expect(message.value).toBe(String.raw`\clip`);
  });

  it('does not overwrite the same draft after its owning session changes', async () => {
    // Given: a clipboard snippet is pending in one session.
    settings.textTransformers.value = [
      {
        id: 'snippet-session-clipboard',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    let resolveClipboard!: (value: string) => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(() => new Promise<string>((resolve) => (resolveClipboard = resolve))),
      },
    });
    const { root, message, currentSessionId } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);
    press(textarea, 'Enter');

    // When: ownership switches while the visible text and selection remain identical.
    currentSessionId.value = 'session-b';
    await nextTick();
    textarea.setSelectionRange(String.raw`\clip`.length, String.raw`\clip`.length);
    resolveClipboard('session-a clipboard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // Then: the stale result cannot commit into the new session.
    expect(message.value).toBe(String.raw`\clip`);
  });

  it('records same-task input ABA changes synchronously', async () => {
    // Given: a clipboard snippet is pending and the draft will change twice in one task.
    settings.textTransformers.value = [
      {
        id: 'snippet-synchronous-clipboard',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    let resolveClipboard!: (value: string) => void;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(() => new Promise<string>((resolve) => (resolveClipboard = resolve))),
      },
    });
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);
    press(textarea, 'Enter');

    // When: synthetic input moves away and back before Vue flushes its watcher.
    textarea.value = 'temporary';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.value = String.raw`\clip`;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    textarea.setSelectionRange(String.raw`\clip`.length, String.raw`\clip`.length);
    resolveClipboard('stale clipboard');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // Then: synchronous input revision tracking rejects the stale result.
    expect(message.value).toBe(String.raw`\clip`);
  });
});
