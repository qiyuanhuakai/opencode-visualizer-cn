import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
afterEach(cleanupInputPanelFixtures);

describe('InputPanel Codex commands', () => {
  it('allows /forge on non-Codex backends without a sendable prompt', async () => {
    const onSend = vi.fn();
    const { root } = mountInputPanel({
      messageInput: '/forge',
      isThinking: true,
      canSend: false,
      disabled: true,
      onSend,
    });
    await nextTick();
    const button = root.querySelector('button.send-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) return;
    expect(button.classList.contains('stop')).toBe(false);
    expect(button.disabled).toBe(false);
    button.click();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('allows commands while a turn is running and prompt sending is disabled', async () => {
    const onSend = vi.fn();
    const { root } = mountInputPanel({
      messageInput: '/usage',
      codexCommandsEnabled: true,
      isThinking: true,
      canSend: false,
      disabled: true,
      onSend,
    });
    await nextTick();
    const button = root.querySelector('button.send-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) return;
    expect(button.disabled).toBe(false);
    button.click();
    expect(onSend).toHaveBeenCalledTimes(1);
  });
  it('keeps the stop button for normal prompts during an active turn', async () => {
    const { root } = mountInputPanel({
      messageInput: 'next task',
      codexCommandsEnabled: true,
      isThinking: true,
      canSend: false,
      canAbort: true,
    });
    await nextTick();
    expect(root.querySelector('button.send-button.stop')).not.toBeNull();
  });
  it('keeps other backends send restrictions intact', async () => {
    const { root } = mountInputPanel({ messageInput: '/usage', canSend: false });
    await nextTick();
    const button = root.querySelector('button.send-button');
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) return;
    expect(button.disabled).toBe(true);
  });
});
