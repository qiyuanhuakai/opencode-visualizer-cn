import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';

import {
  mountInputPanel,
  press,
  settings,
  typeInto,
} from './InputPanel.textTransformer.test-helpers';

describe('InputPanel text transformers', () => {
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

  it('keeps ordinary whitespace out of the snippet completion path', async () => {
    // Given: Snippets are enabled while the composer contains only an ordinary space.
    const { root, message, send } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, ' ');

    // When: matching settles and Enter follows the ordinary composer path.
    expect(textarea.getAttribute('aria-expanded')).toBe('false');
    const event = press(textarea, 'Enter');
    await nextTick();

    // Then: no completion is selected and no snippet body replaces the whitespace.
    expect(event.defaultPrevented).toBe(true);
    expect(message.value).toBe(' ');
    expect(send).toHaveBeenCalledTimes(1);
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
});
