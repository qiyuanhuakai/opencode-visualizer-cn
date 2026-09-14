import { nextTick } from 'vue';
import { describe, expect, it } from 'vitest';

import { mountInputPanel, press, typeInto } from './InputPanel.textTransformer.test-helpers';

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
});
