import { nextTick } from 'vue';
import { describe, expect, it, vi } from 'vitest';

import {
  mountInputPanel,
  press,
  release,
  settings,
  typeInto,
} from './InputPanel.textTransformer.test-helpers';

describe('InputPanel text transformers', () => {
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
    release(textarea, 'Enter');

    // Then: context variables resolve and the caret lands before trailing body text.
    await vi.waitFor(() => {
      expect(message.value).toBe('Before clipboard text\n/repo/src/main.ts\n/repo\nContinue ');
    });
    expect(readText).toHaveBeenCalledTimes(1);
    expect(textarea.selectionStart).toBe(
      'Before clipboard text\n/repo/src/main.ts\n/repo\n'.length,
    );
  });

  it('does not commit captured file context after it changes away and back', async () => {
    // Given: a clipboard snippet captures file and workspace context while its read is pending.
    settings.textTransformers.value = [
      {
        id: 'snippet-context-aba',
        trigger: 'ctx',
        name: 'Insert context',
        body: '{clipboard}:{activeFile}:{cwd}',
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
    const { root, message, activeFile, activeDirectory } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\ctx`);
    press(textarea, 'Enter');

    // When: both context owners change away and back before the clipboard resolves.
    activeFile.value = '/repo/src/other.ts';
    activeDirectory.value = '/other';
    await nextTick();
    activeFile.value = '/repo/src/main.ts';
    activeDirectory.value = '/repo';
    await nextTick();
    resolveClipboard('stale');
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Then: monotonic context identity rejects the stale captured values.
    expect(message.value).toBe(String.raw`\ctx`);
  });

  it('reads clipboard variables through the trusted Electron preload API', async () => {
    // Given: Electron exposes clipboard read through preload while browser clipboard permission fails.
    settings.textTransformers.value = [
      {
        id: 'snippet-electron-clipboard',
        trigger: 'clip',
        name: 'Insert clipboard',
        body: '{clipboard}',
        description: '',
        enabled: true,
        tags: [],
      },
    ];
    const electronReadText = vi.fn().mockResolvedValue('native clipboard');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { clipboard: { readText: electronReadText } },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: vi.fn().mockRejectedValue(new DOMException('Denied')) },
    });
    const { root, message } = mountInputPanel();
    const textarea = root.querySelector('textarea')!;
    await typeInto(textarea, String.raw`\clip`);

    // When: the user confirms the clipboard snippet.
    press(textarea, 'Enter');

    // Then: the trusted preload value is inserted despite renderer permission denial.
    await vi.waitFor(() => expect(message.value).toBe('native clipboard '));
    expect(electronReadText).toHaveBeenCalledTimes(1);
  });
});
