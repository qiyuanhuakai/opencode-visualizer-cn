import { afterEach, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
afterEach(cleanupInputPanelFixtures);

it('cycles the native permissions picker with Tab and Shift-Tab', () => {
  const selected = vi.fn();
  const { root } = mountInputPanel({ selectedMode: 'workspace-write',
    agentOptions: [{ id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace' }, { id: 'danger-full-access', label: 'Full access' }],
    'onUpdate:selectedMode': selected,
  });
  const textarea = root.querySelector('textarea');
  if (!textarea) throw new Error('Missing composer');
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  textarea.dispatchEvent(tab);
  expect(selected).toHaveBeenLastCalledWith('danger-full-access');
  expect(tab.defaultPrevented).toBe(true);
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
  expect(selected).toHaveBeenLastCalledWith('read-only');
});

it('prevents native permission cycling while writes are disabled', () => {
  const selected = vi.fn();
  const { root } = mountInputPanel({ agentPickerDisabled: true, 'onUpdate:selectedMode': selected });
  root.querySelector('textarea')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
  expect(selected).not.toHaveBeenCalled();
});
