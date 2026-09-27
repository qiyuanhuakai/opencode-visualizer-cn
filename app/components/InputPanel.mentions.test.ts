import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

describe('composer file mentions', () => {
  afterEach(cleanupInputPanelFixtures);

  it.each([
    ['kimi-web', [{ id: 'manual', label: 'manual' }]],
    ['codex', [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }]],
    ['acp', [{ id: 'agent', label: 'Agent' }]],
  ])('prioritizes sorted files over agent names for %s @', async (_backend, agentOptions) => {
    const { root } = mountInputPanel({
      messageInput: '@',
      selectedMode: agentOptions[0]?.id ?? '',
      agentOptions,
      mentionFiles: ['zeta', 'alpha.ts', 'Beta', 'apple', 'z.file', '.env', 'dir/berry', 'a.txt'],
      preferFileMentions: true,
    });
    await nextTick();

    const options = [...root.querySelectorAll('#input-mention-listbox .command-name')]
      .map((option) => option.textContent?.trim());
    expect(options).toEqual([
      'dir/', 'a.txt', 'alpha.ts', 'apple', 'Beta',
      'z.file', 'zeta', '.env',
    ]);
    expect(root.querySelectorAll('#input-mention-listbox .mention-file-icon')).toHaveLength(options.length);
    expect(root.textContent).not.toContain('@manual');
    expect(root.textContent).not.toContain('@Plan');
  });

  it('keeps every direct child while placing hidden entries last', async () => {
    const ordinary = Array.from({ length: 35 }, (_, index) => `file${String(index).padStart(2, '0')}`);
    const { root } = mountInputPanel({
      messageInput: '@',
      mentionFiles: ['.zread/wiki/current', 'app/public/LICENSE', ...ordinary.toReversed(), 'src/file99.ts', 'app/assets/LICENSE', '.fallowrc.json'],
      mentionDirectories: ['empty'],
      preferFileMentions: true,
    });
    await nextTick();

    const options = [...root.querySelectorAll('#input-mention-listbox .command-name')]
      .map((option) => option.textContent?.trim());
    expect(options).toEqual([
      'app/', 'empty/', 'src/', ...ordinary, '.zread/', '.fallowrc.json',
    ]);
  });

  it.each(['kimi-web', 'codex', 'acp'])('%s scopes slash queries to direct children and searches only their names', async () => {
    const { root, props } = mountInputPanel({
      messageInput: '@app/',
      mentionFiles: [
        'app/assets/icon.svg', 'app/src/deep.ts', 'app/alpha.ts',
        'docs/app-notes.md', 'app/.config/settings.json',
      ],
      preferFileMentions: true,
    });
    props['onUpdate:messageInput'] = (value) => { props.messageInput = value; };
    await nextTick();
    const textarea = root.querySelector('textarea');
    const options = () => [...root.querySelectorAll('#input-mention-listbox .command-name')]
      .map((option) => option.textContent?.trim());
    expect(options()).toEqual(['assets/', 'src/', 'alpha.ts', '.config/']);

    if (textarea) {
      textarea.value = '@app/as';
      textarea.setSelectionRange(7, 7);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    expect(options()).toEqual(['assets/']);

    if (textarea) {
      textarea.value = '@app/src/de';
      textarea.setSelectionRange(11, 11);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    expect(options()).toEqual(['deep.ts']);

    if (textarea) {
      textarea.value = '@appx/';
      textarea.setSelectionRange(6, 6);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await nextTick();
    expect(options()).toEqual([]);
  });

  it.each(['kimi-web', 'codex', 'acp'])('%s uses Tab for folders and Enter for a file', async () => {
    const { root, props } = mountInputPanel({
      messageInput: '@', mentionFiles: ['app/src/deep.ts', 'docs/readme.md'], preferFileMentions: true,
    });
    props['onUpdate:messageInput'] = (value) => { props.messageInput = value; };
    await nextTick();
    const textarea = root.querySelector('textarea');
    expect(textarea).not.toBeNull();
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await nextTick();
    expect(props.messageInput).toBe('@app/');
    await vi.waitFor(() => {
      expect(textarea?.selectionStart).toBe('@app/'.length);
      expect(root.querySelector('.command-name')?.textContent?.trim()).toBe('src/');
    });
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    await nextTick();
    expect(props.messageInput).toBe('@app/src/');
    await vi.waitFor(() => {
      expect(textarea?.selectionStart).toBe('@app/src/'.length);
    });
    textarea?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await nextTick();
    expect(props.messageInput).toBe('@app/src/deep.ts ');
  });

  it.each(['kimi-web', 'codex', 'acp'])('%s also confirms a highlighted file with Tab', async () => {
    const { root, props } = mountInputPanel({
      messageInput: '@app/src/de', mentionFiles: ['app/src/deep.ts'], preferFileMentions: true,
    });
    props['onUpdate:messageInput'] = (value) => { props.messageInput = value; };
    await nextTick();
    root.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }));
    await nextTick();
    expect(props.messageInput).toBe('@app/src/deep.ts ');
  });

  it('closes the file popup after inserting the selected path', async () => {
    const { root, props } = mountInputPanel({
      messageInput: '@',
      mentionFiles: ['Beta'],
      preferFileMentions: true,
    });
    props['onUpdate:messageInput'] = (value) => { props.messageInput = value; };
    await nextTick();

    root.querySelector<HTMLElement>('#input-mention-listbox [role="option"]')?.click();
    await nextTick();
    expect(props.messageInput).toBe('@Beta ');
    await vi.waitFor(() => {
      expect(root.querySelector('textarea')?.getAttribute('aria-expanded')).toBe('false');
    });
  });
});
