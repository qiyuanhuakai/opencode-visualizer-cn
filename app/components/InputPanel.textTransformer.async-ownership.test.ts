import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import {
  mountInputPanel,
  press,
  settings,
  typeInto,
} from './InputPanel.textTransformer.test-helpers';

describe('InputPanel text transformers', () => {
  it('preserves the draft and caret when browser clipboard permission is denied', async () => {
    // Given: a clipboard Snippet is selected while the browser clipboard read will reject.
    settings.textTransformers.value = [
      {
        id: 'snippet-browser-clipboard-denied',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    const readText = vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText },
    });
    const { root, message, statusError } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);
    const originalCaret = textarea.selectionStart;

    // When: the user confirms the Snippet and the clipboard request fails.
    press(textarea, 'Enter');
    await vi.waitFor(() => expect(readText).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // Then: no empty clipboard value is inserted and the failure is visible to the user.
    expect(message.value).toBe(String.raw`\clip`);
    expect(textarea.selectionStart).toBe(originalCaret);
    expect(statusError).toHaveBeenCalledWith(
      'Clipboard could not be read. The Snippet was not inserted.',
    );
  });

  it('preserves the draft when the trusted Electron clipboard read rejects', async () => {
    // Given: Electron owns clipboard access and its trusted preload call will reject.
    settings.textTransformers.value = [
      {
        id: 'snippet-electron-clipboard-denied',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    const electronReadText = vi.fn().mockRejectedValue(new Error('Native clipboard unavailable'));
    const browserReadText = vi.fn().mockResolvedValue('must not be used');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { clipboard: { readText: electronReadText } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: browserReadText },
    });
    const { root, message, statusError } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);

    // When: the user confirms the Snippet and the Electron IPC request fails.
    press(textarea, 'Enter');
    await vi.waitFor(() => expect(electronReadText).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    // Then: Electron does not silently fall through or replace the draft with an empty value.
    expect(browserReadText).not.toHaveBeenCalled();
    expect(message.value).toBe(String.raw`\clip`);
    expect(statusError).toHaveBeenCalledWith(
      'Clipboard could not be read. The Snippet was not inserted.',
    );
  });

  it('does not commit after the selection moves away and back during clipboard resolution', async () => {
    // Given: a clipboard snippet is pending at one collapsed selection.
    settings.textTransformers.value = [
      {
        id: 'snippet-selection-clipboard',
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

    // When: selection ownership moves away and back to the captured endpoints before resolution.
    textarea.setSelectionRange(0, 0);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
    textarea.setSelectionRange(String.raw`\clip`.length, String.raw`\clip`.length);
    textarea.dispatchEvent(new Event('select', { bubbles: true }));
    resolveClipboard('stale clipboard');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Then: monotonic selection identity rejects the stale result.
    expect(message.value).toBe(String.raw`\clip`);
  });

  it('does not commit after session ownership changes away and back', async () => {
    // Given: a clipboard snippet is pending in session A.
    settings.textTransformers.value = [
      {
        id: 'snippet-session-aba-clipboard',
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

    // When: ownership changes A to B to A before the clipboard promise resolves.
    currentSessionId.value = 'session-b';
    await nextTick();
    currentSessionId.value = 'session-a';
    await nextTick();
    resolveClipboard('session-a stale clipboard');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Then: monotonic session identity rejects the stale result.
    expect(message.value).toBe(String.raw`\clip`);
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
    const readText = vi.fn(() => new Promise<string>((resolve) => (resolveClipboard = resolve)));
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
