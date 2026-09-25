import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

describe('composer file mentions', () => {
  afterEach(cleanupInputPanelFixtures);

  it.each([
    ['kimi-web', [{ id: 'manual', label: 'manual' }]],
    ['codex', [{ id: 'default', label: 'Default' }, { id: 'plan', label: 'Plan' }]],
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
      '@apple', '@dir/berry', '@Beta', '@zeta',
      '@.env', '@a.txt', '@alpha.ts', '@z.file',
    ]);
    expect(root.textContent).not.toContain('@manual');
    expect(root.textContent).not.toContain('@Plan');
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
